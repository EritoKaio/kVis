import net from 'node:net'
import KRPC from 'krpc.js'
import { WebSocket, WebSocketServer } from 'ws'

const kspHost = process.env.KRPC_HOST ?? '127.0.0.1'
const kspRpcPort = Number(process.env.KRPC_RPC_PORT ?? 50000)
const kspStreamPort = Number(process.env.KRPC_STREAM_PORT ?? 50001)
const proxyRpcPort = Number(process.env.KRPC_PROXY_RPC_PORT ?? 51000)
const proxyStreamPort = Number(process.env.KRPC_PROXY_STREAM_PORT ?? 51001)
const telemetryPort = Number(process.env.KVIS_TELEMETRY_PORT ?? 5174)
const maxFrameSize = 16 * 1024 * 1024

function encodeVarint(value) {
  const bytes = []
  let remaining = value
  while (remaining > 127) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)
  return Buffer.from(bytes)
}

function encodeBytesField(field, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes])
}

function encodeVarintField(field, value) {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)])
}

function encodeFrame(message) {
  return Buffer.concat([encodeVarint(message.length), message])
}

function readVarint(buffer, offset) {
  let value = 0
  let shift = 0
  for (let index = offset; index < buffer.length && shift < 35; index += 1) {
    const byte = buffer[index]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, offset: index + 1 }
    shift += 7
  }
  if (shift >= 35) throw new Error('Invalid protobuf varint')
  return null
}

function readFrame(buffer) {
  const length = readVarint(buffer, 0)
  if (!length) return null
  if (length.value > maxFrameSize) throw new Error(`kRPC frame exceeds ${maxFrameSize} bytes`)
  if (buffer.length < length.offset + length.value) return null
  return {
    message: buffer.subarray(length.offset, length.offset + length.value),
    remainder: buffer.subarray(length.offset + length.value),
  }
}

function decodeConnectionResponse(message) {
  let offset = 0
  let status = 0
  let detail = ''

  while (offset < message.length) {
    const tag = readVarint(message, offset)
    if (!tag) throw new Error('Incomplete kRPC connection response')
    offset = tag.offset
    const field = Math.floor(tag.value / 8)
    const wireType = tag.value & 7

    if (wireType === 0) {
      const value = readVarint(message, offset)
      if (!value) throw new Error('Incomplete kRPC connection response field')
      offset = value.offset
      if (field === 1) status = value.value
    } else if (wireType === 2) {
      const length = readVarint(message, offset)
      if (!length) throw new Error('Incomplete kRPC connection response field')
      offset = length.offset
      const end = offset + length.value
      if (end > message.length) throw new Error('Invalid kRPC connection response length')
      if (field === 2) detail = message.toString('utf8', offset, end)
      offset = end
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4
      if (offset > message.length) throw new Error('Invalid kRPC connection response field')
    } else {
      throw new Error(`Unsupported kRPC connection response wire type ${wireType}`)
    }
  }

  if (status !== 0) {
    throw new Error(detail || `kRPC rejected the connection with status ${status}`)
  }
}

function createConnectionRequest({ stream, name, clientId }) {
  const fields = []
  if (stream) fields.push(encodeVarintField(1, 1))
  if (name) fields.push(encodeBytesField(2, name))
  if (clientId) fields.push(encodeBytesField(3, clientId))
  fields.push(encodeVarintField(4, 1))
  return Buffer.concat(fields)
}

function createProxyServer({ port, targetPort, stream }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port })

  server.on('connection', (websocket, request) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const name = url.searchParams.get('name') ?? 'kVis'
    const encodedClientId = url.searchParams.get('id')
    const clientId =
      stream && encodedClientId
        ? Buffer.from(encodedClientId.replaceAll(' ', '+'), 'base64')
        : null
    const tcp = net.createConnection({ host: kspHost, port: targetPort })
    let tcpBuffer = Buffer.alloc(0)
    let connected = false
    let closed = false
    const pendingMessages = []

    const closeConnection = (error) => {
      if (closed) return
      closed = true
      if (error) {
        console.error(`kRPC ${stream ? 'stream' : 'RPC'} proxy: ${error.message}`)
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.close(1011, error.message.slice(0, 120))
        }
      } else if (websocket.readyState === WebSocket.OPEN) {
        websocket.close()
      }
      tcp.destroy()
    }

    if (stream && !clientId) {
      closeConnection(new Error('Stream connection is missing its client identifier'))
      return
    }

    tcp.setTimeout(8000)
    tcp.on('timeout', () => closeConnection(new Error('Timed out connecting to the kRPC TCP server')))
    tcp.on('connect', () => {
      tcp.write(encodeFrame(createConnectionRequest({ stream, name, clientId })))
    })
    tcp.on('data', (chunk) => {
      try {
        tcpBuffer = Buffer.concat([tcpBuffer, chunk])
        let frame = readFrame(tcpBuffer)
        while (frame) {
          tcpBuffer = frame.remainder
          if (!connected) {
            decodeConnectionResponse(frame.message)
            connected = true
            tcp.setTimeout(0)
            for (const message of pendingMessages.splice(0)) {
              tcp.write(encodeFrame(message))
            }
          } else if (websocket.readyState === WebSocket.OPEN) {
            websocket.send(frame.message, { binary: true })
          }
          frame = readFrame(tcpBuffer)
        }
      } catch (error) {
        closeConnection(error)
      }
    })
    tcp.on('error', (error) => closeConnection(error))
    tcp.on('close', () => {
      if (!closed) closeConnection(new Error('kRPC TCP connection closed'))
    })

    websocket.on('message', (data, isBinary) => {
      if (!isBinary) {
        closeConnection(new Error('Expected a binary kRPC WebSocket message'))
        return
      }
      const message = Buffer.from(data)
      if (connected) {
        tcp.write(encodeFrame(message))
      } else if (pendingMessages.length < 128) {
        pendingMessages.push(message)
      } else {
        closeConnection(new Error('Too many messages queued during kRPC connection setup'))
      }
    })
    websocket.on('error', (error) => closeConnection(error))
    websocket.on('close', () => closeConnection())
  })

  server.on('error', (error) => {
    console.error(`kRPC proxy on port ${port}: ${error.message}`)
  })

  return server
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

async function main() {
  const rpcProxy = createProxyServer({ port: proxyRpcPort, targetPort: kspRpcPort, stream: false })
  const streamProxy = createProxyServer({
    port: proxyStreamPort,
    targetPort: kspStreamPort,
    stream: true,
  })
  const telemetryServer = new WebSocketServer({ host: '127.0.0.1', port: telemetryPort })
  const servers = [rpcProxy, streamProxy, telemetryServer]
  await Promise.all(servers.map(listen))

  let telemetry = {
    state: 'connecting',
    vesselName: null,
    altitude: null,
    bodyTransforms: {},
  }
  const broadcast = () => {
    const message = JSON.stringify(telemetry)
    for (const client of telemetryServer.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message)
    }
  }
  telemetryServer.on('connection', (client) => {
    client.send(JSON.stringify(telemetry))
  })

  console.log(`kRPC TCP proxy: ${kspHost}:${kspRpcPort}/${kspStreamPort}`)
  console.log(`App telemetry WebSocket: ws://127.0.0.1:${telemetryPort}`)

  const connection = new KRPC({
    host: '127.0.0.1',
    rpcPort: proxyRpcPort,
    streamPort: proxyStreamPort,
    name: 'kVis',
    streamRate: 10,
  })

  try {
    await connection.load()
    const spaceCenter = connection.services.spaceCenter
    const bodies = await spaceCenter.bodies
    const bodyEntries = await Promise.all(
      Object.values(bodies).map(async (body) => ({
        body,
        name: await body.name,
      })),
    )
    const sunEntry = bodyEntries.find(({ name }) =>
      ['kerbol', 'sun'].includes(name.toLowerCase()),
    )
    if (!sunEntry) {
      throw new Error('The kRPC body catalog does not contain Kerbol or Sun')
    }
    const sun = sunEntry.body
    const systemReferenceFrame = await sun.nonRotatingReferenceFrame

    for (const { body, name } of bodyEntries) {
      const bodyName = name.toLowerCase() === 'sun' ? 'Kerbol' : name
      const updateTransform = (property, value) => {
        const bodyTransforms = telemetry.bodyTransforms ?? {}
        const currentTransform = bodyTransforms[bodyName] ?? {}
        telemetry = {
          ...telemetry,
          bodyTransforms: {
            ...bodyTransforms,
            [bodyName]: { ...currentTransform, [property]: value },
          },
        }
        broadcast()
      }

      const positionStream = await connection.addStream(
        spaceCenter.calls.CelestialBody_Position(body, systemReferenceFrame),
        (position) => updateTransform('position', position),
      )
      await positionStream.stream.setRate(1)

      const rotationStream = await connection.addStream(
        spaceCenter.calls.CelestialBody_Rotation(body, systemReferenceFrame),
        (rotation) => updateTransform('rotation', rotation),
      )
      await rotationStream.stream.setRate(10)

      const rotationAngleStream = await body.stream('rotationAngle', (rotationAngle) =>
        updateTransform('rotationAngle', rotationAngle),
      )
      await rotationAngleStream.stream.setRate(10)
    }

    console.log(`Streaming transforms for ${Object.keys(bodies).length} celestial bodies`)

    const orbitProperties = [
      'semiMajorAxis',
      'eccentricity',
      'inclination',
      'longitudeOfAscendingNode',
      'argumentOfPeriapsis',
      'trueAnomaly',
    ]

    let activeVesselId
    let vesselStreams = []
    let syncInProgress = false

    const removeVesselStreams = async () => {
      const streams = vesselStreams
      vesselStreams = []
      for (const stream of streams) {
        await stream.remove()
      }
    }

    const syncActiveVessel = async () => {
      const vessel = await spaceCenter.activeVessel
      if (!vessel) {
        if (activeVesselId === null) return
        if (activeVesselId !== undefined) {
          await removeVesselStreams()
        }
        activeVesselId = null
        telemetry = {
          state: 'no-vessel',
          vesselId: null,
          vesselName: null,
          altitude: null,
          orbit: null,
          attitude: null,
          position: null,
          velocity: null,
          bodyTransforms: telemetry.bodyTransforms ?? {},
        }
        broadcast()
        return
      }

      const vesselId = String(vessel.id)
      if (vesselId === activeVesselId) return

      await removeVesselStreams()
      activeVesselId = vesselId
      const vesselName = await vessel.name
      const referenceFrame = await vessel.orbitalReferenceFrame
      const flight = await vessel.flight(referenceFrame)
      const orbit = await vessel.orbit
      const body = await orbit.body
      const bodyReferenceFrame = await body.nonRotatingReferenceFrame
      const velocityFlight = await vessel.flight(bodyReferenceFrame)
      const orbitData = {
        bodyName: await body.name,
        bodyRadius: await body.equatorialRadius,
        atmosphereDepth: await body.atmosphereDepth,
        gravitationalParameter: await body.gravitationalParameter,
        rotationAngle: await body.rotationAngle,
        semiMajorAxis: await orbit.semiMajorAxis,
        eccentricity: await orbit.eccentricity,
        inclination: await orbit.inclination,
        longitudeOfAscendingNode: await orbit.longitudeOfAscendingNode,
        argumentOfPeriapsis: await orbit.argumentOfPeriapsis,
        trueAnomaly: await orbit.trueAnomaly,
      }

      telemetry = {
        state: 'connected',
        vesselId,
        vesselName,
        altitude: await flight.meanAltitude,
        speed: await velocityFlight.speed,
        gForce: await flight.gForce,
        attitude: await vessel.rotation(bodyReferenceFrame),
        position: await vessel.position(bodyReferenceFrame),
        velocity: await vessel.velocity(bodyReferenceFrame),
        orbit: orbitData,
        bodyTransforms: telemetry.bodyTransforms ?? {},
      }
      broadcast()
      console.log(`Active vessel changed: ${vesselName}`)

      const isCurrentVessel = () => activeVesselId === vesselId
      const attitudeStream = await connection.addStream(
        spaceCenter.calls.Vessel_Rotation(vessel, bodyReferenceFrame),
        (attitude) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, attitude }
          broadcast()
        },
      )
      await attitudeStream.stream.setRate(10)
      const positionStream = await connection.addStream(
        spaceCenter.calls.Vessel_Position(vessel, bodyReferenceFrame),
        (position) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, position }
          broadcast()
        },
      )
      await positionStream.stream.setRate(10)
      const velocityStream = await connection.addStream(
        spaceCenter.calls.Vessel_Velocity(vessel, bodyReferenceFrame),
        (velocity) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, velocity }
          broadcast()
        },
      )
      await velocityStream.stream.setRate(10)
      vesselStreams = [
        await flight.stream('meanAltitude', (altitude) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, altitude }
          broadcast()
        }),
        await velocityFlight.stream('speed', (speed) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, speed }
          broadcast()
        }),
        await flight.stream('gForce', (gForce) => {
          if (!isCurrentVessel()) return
          telemetry = { ...telemetry, gForce }
          broadcast()
        }),
        attitudeStream,
        positionStream,
        velocityStream,
      ]
      for (const property of orbitProperties) {
        vesselStreams.push(
          await orbit.stream(property, (value) => {
            if (!isCurrentVessel()) return
            orbitData[property] = value
            telemetry = { ...telemetry, orbit: orbitData }
            broadcast()
          }),
        )
      }
      vesselStreams.push(
        await body.stream('rotationAngle', (rotationAngle) => {
          if (!isCurrentVessel()) return
          orbitData.rotationAngle = rotationAngle
          telemetry = { ...telemetry, orbit: orbitData }
          broadcast()
        }),
      )
    }

    await syncActiveVessel()
    setInterval(() => {
      if (syncInProgress) return
      syncInProgress = true
      syncActiveVessel().catch((error) => {
        console.error('Failed to check the active kRPC vessel:', error)
      }).finally(() => {
        syncInProgress = false
      })
    }, 1000)
  } catch (error) {
    if (connection.rpcSocket) connection.close()
    for (const server of servers) server.close()
    throw error
  }
}

main().catch((error) => {
  console.error('kVis kRPC bridge failed:', error)
  process.exitCode = 1
})
