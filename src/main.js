import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { celestialBodies } from './celestialBodies.js'

const bodiesById = Object.fromEntries(celestialBodies.map((body) => [body.id, body]))

const app = document.querySelector('#app')
app.innerHTML = `
  <header class="topbar">
    <a class="wordmark" href="/" aria-label="kVis mission view">k<span>V</span>is</a>
    <div class="topbar-context">
      <span class="eyebrow">MISSION VIEW</span>
      <span class="topbar-divider"></span>
      <label class="sr-only" for="body-selector">Select celestial body</label>
      <select class="body-selector" id="body-selector" aria-label="Select celestial body">
        ${celestialBodies
          .map(
            (body) =>
              `<option value="${body.id}"${body.id === 'kerbin' ? ' selected' : ''}>${body.type === 'moon' ? `- ${body.name}` : body.name}</option>`,
          )
          .join('')}
      </select>
    </div>
    <div class="topbar-telemetry">
      <span class="telemetry-altitude">ALT <b id="vessel-altitude">--</b></span>
      <div class="preview-state" id="link-state"><span></span><b>DEMO FLIGHT</b></div>
      <a class="telemetry-widget-link" href="/telemetry.html" target="_blank" rel="noopener">TELEMETRY WIDGET ↗</a>
    </div>
  </header>
  <main class="viewport" aria-label="3D planet preview">
    <canvas id="planet-canvas" aria-label="3D celestial body preview"></canvas>
    <div class="vessel-tag" id="vessel-tag" aria-live="polite"></div>
    <div class="apsis-tag" id="periapsis-tag">Pe</div>
    <div class="apsis-tag" id="apoapsis-tag">Ap</div>
  </main>
`

const linkState = document.querySelector('#link-state')
const topbar = document.querySelector('.topbar')
const vesselAltitudeLabel = document.querySelector('#vessel-altitude')
const bodySelector = document.querySelector('#body-selector')
const vesselTag = document.querySelector('#vessel-tag')
const periapsisTag = document.querySelector('#periapsis-tag')
const apoapsisTag = document.querySelector('#apoapsis-tag')
let selectedBody = bodiesById.kerbin
let latestTelemetry = null
let latestBodyTransforms = {}
let menuHideTimer = 0
let liveBodyOrientationActive = false
let vesselTrackingActive = true
const labelAltitudeThreshold = 80_000

function shouldShowVesselLabels() {
  if (!vesselTrackingActive) return false
  if (latestTelemetry?.state !== 'connected') return true
  return (
    Number.isFinite(latestTelemetry.altitude) &&
    latestTelemetry.altitude > labelAltitudeThreshold
  )
}

document.addEventListener('pointermove', (event) => {
  window.clearTimeout(menuHideTimer)
  if (event.clientY <= 72) {
    topbar.classList.add('is-visible')
    return
  }
  menuHideTimer = window.setTimeout(() => topbar.classList.remove('is-visible'), 450)
})

function setLinkState(label, isLive = false) {
  linkState.lastElementChild.textContent = label
  linkState.classList.toggle('is-live', isLive)
}

let connectionFailureLogged = false

function resetTelemetryDisplay() {
  setLinkState('DEMO FLIGHT')
  vesselAltitudeLabel.textContent = '--'
  latestTelemetry = null
  latestBodyTransforms = {}
  liveBodyOrientationActive = false
  vesselTrackingActive = true
  updateVesselLabel('DEMO VESSEL')
  updateOrbitVisualization(demoOrbit)
  updateSunlight()
}

function connectTelemetry() {
  const telemetrySocket = new WebSocket('ws://127.0.0.1:5174')
  telemetrySocket.addEventListener('open', () => {
    connectionFailureLogged = false
    setLinkState('CONNECTING')
  })
  telemetrySocket.addEventListener('message', (event) => {
    let telemetry
    try {
      telemetry = JSON.parse(event.data)
    } catch (error) {
      console.error('Received invalid telemetry from the local kRPC bridge', error)
      return
    }

    if (telemetry.bodyTransforms && typeof telemetry.bodyTransforms === 'object') {
      latestBodyTransforms = telemetry.bodyTransforms
      updateBodyOrientation(activeOrbit.rotationAngle)
      updateSunlight()
    }

    if (telemetry.state !== 'connected') {
      if (telemetry.state === 'no-vessel') {
        setLinkState('NO ACTIVE VESSEL')
        vesselAltitudeLabel.textContent = '--'
        latestTelemetry = telemetry
        vesselTrackingActive = false
        updateOrbitVisualization(demoOrbit)
      } else {
        setLinkState('CONNECTING')
      }
      return
    }

    setLinkState('LIVE TELEMETRY', true)
    updateVesselLabel(telemetry.vesselName || 'ACTIVE VESSEL')
    vesselTrackingActive = true
    const vesselChanged = telemetry.vesselId !== latestTelemetry?.vesselId
    latestTelemetry = telemetry
    const telemetryBody = celestialBodies.find(
      (body) => body.name.toLowerCase() === telemetry.orbit?.bodyName?.toLowerCase(),
    )
    if (vesselChanged && telemetryBody && selectedBody.id !== telemetryBody.id) {
      bodySelector.value = telemetryBody.id
      selectBody(telemetryBody.id)
    }
    if (
      telemetry.orbit &&
      telemetry.orbit.bodyName?.toLowerCase() === selectedBody.id &&
      updateOrbitVisualization(telemetry.orbit, true)
    ) {
      updateVesselMarker(telemetry.orbit.trueAnomaly)
    }
    if (Number.isFinite(telemetry.altitude)) {
      vesselAltitudeLabel.textContent =
        telemetry.altitude >= 1000
          ? `${(telemetry.altitude / 1000).toFixed(1)} km`
          : `${Math.round(telemetry.altitude)} m`
    }
  })
  telemetrySocket.addEventListener('error', (error) => {
    if (!connectionFailureLogged) {
      console.error('Could not connect to the local kRPC bridge at ws://127.0.0.1:5174', error)
      connectionFailureLogged = true
    }
  })
  telemetrySocket.addEventListener('close', () => {
    resetTelemetryDisplay()
    window.setTimeout(connectTelemetry, 2000)
  })
}

const canvas = document.querySelector('#planet-canvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15

const scene = new THREE.Scene()
scene.background = new THREE.Color('#030508')
const environmentUrl = `${import.meta.env.BASE_URL}assets/environment/space-background.svg`
const environmentTexture = new THREE.TextureLoader().load(
  environmentUrl,
  (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace
  },
  undefined,
  (error) => console.error(`Failed to load environment texture from ${environmentUrl}`, error),
)
environmentTexture.mapping = THREE.EquirectangularReflectionMapping
scene.background = environmentTexture

const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 100)
camera.up.set(0, 0, 1)
camera.position.set(0, 2.2, 0.1)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enablePan = false
controls.enableDamping = true
controls.minDistance = 0.4
controls.maxDistance = 22
controls.autoRotate = false

let placeholderTexture = createBodyTexture(selectedBody)
const planetMaterial = new THREE.MeshStandardMaterial({
  map: placeholderTexture,
  roughness: 0.94,
  metalness: 0.02,
})
const planetRadius = 2.15
const bodySpinGroup = new THREE.Group()
scene.add(bodySpinGroup)
const planet = new THREE.Mesh(new THREE.SphereGeometry(planetRadius, 96, 64), planetMaterial)
planet.rotation.x = Math.PI / 2
bodySpinGroup.add(planet)

const kerbinTextureUrl = `${import.meta.env.BASE_URL}assets/celestial_bodies/kerbin/kerbin_texture.jpg`
let kerbinTextureAsset = null
new THREE.TextureLoader().load(
  kerbinTextureUrl,
  (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace
    kerbinTextureAsset = texture
    if (selectedBody.id === 'kerbin') {
      placeholderTexture.dispose()
      placeholderTexture = texture
      planetMaterial.map = texture
      planetMaterial.needsUpdate = true
    }
  },
  undefined,
  (error) => console.error(`Failed to load Kerbin texture from ${kerbinTextureUrl}`, error),
)

const orbit = new THREE.Group()
scene.add(orbit)

const orbitLine = new THREE.LineLoop(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85 }),
)
orbit.add(orbitLine)

const periapsisPosition = new THREE.Vector3()
const apoapsisPosition = new THREE.Vector3()

const vesselMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.075, 20, 20),
  new THREE.MeshBasicMaterial({ color: '#ffe1a8' }),
)
const vesselMarkerDiameter = 0.3
const vesselMarkerScreenDiameter = 18
const markerGlow = new THREE.Mesh(
  new THREE.SphereGeometry(0.15, 20, 20),
  new THREE.MeshBasicMaterial({ color: '#58aaff', transparent: true, opacity: 0.28 }),
)
vesselMarker.add(markerGlow)
orbit.add(vesselMarker)
updateVesselLabel('DEMO VESSEL')
const followedPosition = new THREE.Vector3()
const vesselWorldPosition = new THREE.Vector3()
const followedPositionDelta = new THREE.Vector3()
const cameraOutwardDirection = new THREE.Vector3()
const cameraOutwardPosition = new THREE.Vector3()
const projectedPosition = new THREE.Vector3()
const markerViewPosition = new THREE.Vector3()
const surfaceTrackPosition = new THREE.Vector3()
const surfaceTrackGeometry = new THREE.BufferGeometry()
surfaceTrackGeometry.setAttribute(
  'position',
  new THREE.Float32BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage),
)
const surfaceTrackLine = new THREE.Line(
  surfaceTrackGeometry,
  new THREE.LineBasicMaterial({ color: '#d9e8ff', transparent: true, opacity: 0.3 }),
)
surfaceTrackLine.frustumCulled = false
orbit.add(surfaceTrackLine)

const demoOrbit = {
  bodyName: 'Kerbin',
  bodyRadius: planetRadius,
  rotationAngle: 0,
  semiMajorAxis: 4.4,
  eccentricity: 0.36,
  inclination: 0.56,
  longitudeOfAscendingNode: 0.12,
  argumentOfPeriapsis: -0.28,
  trueAnomaly: 0,
}
// Map KSP's left-handed (x, y, z) basis to the scene's (x, z, y) basis.
const kspToSceneTransform = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
)
const sceneToKspTransform = kspToSceneTransform.clone().invert()
const bodyFrameRotation = new THREE.Quaternion()
const bodySpinInverse = new THREE.Quaternion()
const nonRotatingFrameRotation = new THREE.Quaternion()
const bodyFrameMatrix = new THREE.Matrix4()
const sunDirection = new THREE.Vector3()
const selectedBodyPosition = new THREE.Vector3()
const offlineSunDirection = new THREE.Vector3(-4, 2.5, 5).normalize()
const sunLightDistance = 100
let activeOrbit = demoOrbit
let activeOrbitRotation = new THREE.Matrix4()
let activeSemiMajorAxis = demoOrbit.semiMajorAxis
let liveOrbitActive = false
let orbitGeometrySignature = ''

function isValidOrbit(data) {
  return (
    Number.isFinite(data.bodyRadius) &&
    data.bodyRadius > 0 &&
    Number.isFinite(data.semiMajorAxis) &&
    data.semiMajorAxis > 0 &&
    Number.isFinite(data.eccentricity) &&
    data.eccentricity >= 0 &&
    data.eccentricity < 1 &&
    [
      data.inclination,
      data.longitudeOfAscendingNode,
      data.argumentOfPeriapsis,
      data.rotationAngle,
      data.trueAnomaly,
    ].every(Number.isFinite)
  )
}

function updateOrbitVisualization(data, isLive = false) {
  if (!isValidOrbit(data)) return false

  activeOrbit = data
  updateBodyOrientation(data.rotationAngle)
  activeSemiMajorAxis = (data.semiMajorAxis / data.bodyRadius) * planetRadius
  activeOrbitRotation = new THREE.Matrix4()
    .makeRotationZ(data.longitudeOfAscendingNode)
    .multiply(new THREE.Matrix4().makeRotationX(data.inclination))
    .multiply(new THREE.Matrix4().makeRotationZ(data.argumentOfPeriapsis))
  const signature = [
    activeSemiMajorAxis,
    data.eccentricity,
    data.inclination,
    data.longitudeOfAscendingNode,
    data.argumentOfPeriapsis,
  ].join(':')
  if (signature !== orbitGeometrySignature) {
    const points = Array.from({ length: 256 }, (_, index) => {
      const trueAnomaly = (index / 256) * Math.PI * 2
      return positionOnOrbit(trueAnomaly)
    })
    orbitLine.geometry.dispose()
    orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(points)

    periapsisPosition.copy(positionOnOrbit(0))
    apoapsisPosition.copy(positionOnOrbit(Math.PI))
    orbitGeometrySignature = signature
  }

  liveOrbitActive = isLive
  return true
}

function positionOnOrbit(trueAnomaly, target = new THREE.Vector3()) {
  const eccentricity = activeOrbit.eccentricity
  const distance =
    (activeSemiMajorAxis * (1 - eccentricity ** 2)) /
    (1 + eccentricity * Math.cos(trueAnomaly))
  return target.set(
    distance * Math.cos(trueAnomaly),
    distance * Math.sin(trueAnomaly),
    0,
  ).applyMatrix4(activeOrbitRotation)
}

function updateVesselMarker(trueAnomaly) {
  if (Number.isFinite(trueAnomaly)) {
    positionOnOrbit(trueAnomaly, vesselMarker.position)
  }
}

function updateVesselLabel(name) {
  vesselTag.textContent = name
}

updateOrbitVisualization(demoOrbit)
bodySelector.addEventListener('change', () => selectBody(bodySelector.value))
connectTelemetry()

function selectBody(bodyId) {
  const body = bodiesById[bodyId]
  if (!body) return

  selectedBody = body
  canvas.setAttribute('aria-label', `3D ${body.name} preview`)
  const previousMap = planetMaterial.map
  placeholderTexture =
    body.id === 'kerbin' && kerbinTextureAsset ? kerbinTextureAsset : createBodyTexture(body)
  planetMaterial.map = placeholderTexture
  planetMaterial.color.set('#ffffff')
  planetMaterial.emissive.set(body.type === 'star' ? body.color : '#000000')
  planetMaterial.emissiveIntensity = body.type === 'star' ? 0.65 : 0
  planetMaterial.needsUpdate = true
  if (
    previousMap &&
    previousMap !== placeholderTexture &&
    previousMap !== kerbinTextureAsset
  ) {
    previousMap.dispose()
  }

  const liveOrbit = latestTelemetry?.orbit
  if (liveOrbit && liveOrbit.bodyName?.toLowerCase() === body.id) {
    if (updateOrbitVisualization(liveOrbit, true)) updateVesselMarker(liveOrbit.trueAnomaly)
  } else {
    updateOrbitVisualization(demoOrbit)
  }
  updateSunlight()
}

const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(planetRadius + 0.04, 96, 64),
  new THREE.MeshBasicMaterial({
    color: '#6e9fdb',
    transparent: true,
    opacity: 0.09,
    side: THREE.BackSide,
  }),
)
planet.add(atmosphere)

scene.add(new THREE.AmbientLight('#8994a5', 0.04))
const keyLight = new THREE.DirectionalLight('#e5e9f0', 3.2)
keyLight.position.set(-4, 2.5, 5)
scene.add(keyLight)

function updateBodyOrientation(rotationAngle) {
  const transform = latestBodyTransforms[selectedBody.name]
  const bodyRotationAngle = Number.isFinite(transform?.rotationAngle)
    ? transform.rotationAngle
    : rotationAngle
  if (
    Array.isArray(transform?.rotation) &&
    transform.rotation.length === 4 &&
    transform.rotation.every(Number.isFinite)
  ) {
    bodyFrameRotation.set(...transform.rotation).normalize()
    bodyFrameMatrix
      .makeRotationFromQuaternion(bodyFrameRotation)
      .premultiply(kspToSceneTransform)
      .multiply(sceneToKspTransform)
    bodySpinGroup.quaternion.setFromRotationMatrix(bodyFrameMatrix)
    if (Number.isFinite(bodyRotationAngle)) {
      bodySpinInverse.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -bodyRotationAngle)
      nonRotatingFrameRotation
        .copy(bodySpinGroup.quaternion)
        .multiply(bodySpinInverse)
        .normalize()
      orbit.quaternion.copy(nonRotatingFrameRotation)
    } else {
      orbit.quaternion.copy(bodySpinGroup.quaternion)
    }
    liveBodyOrientationActive = true
  } else {
    bodySpinGroup.rotation.set(0, 0, Number.isFinite(bodyRotationAngle) ? bodyRotationAngle : 0)
    orbit.rotation.set(0, 0, 0)
    liveBodyOrientationActive = Boolean(
      latestTelemetry?.state === 'connected' &&
        latestTelemetry.orbit?.bodyName?.toLowerCase() === selectedBody.id &&
        Number.isFinite(latestTelemetry.orbit.rotationAngle),
    )
  }
}

function updateSunlight() {
  const bodyTransform = latestBodyTransforms[selectedBody.name]
  const sunTransform = latestBodyTransforms.Kerbol
  if (
    !Array.isArray(bodyTransform?.position) ||
    bodyTransform.position.length !== 3 ||
    !bodyTransform.position.every(Number.isFinite) ||
    !Array.isArray(sunTransform?.position) ||
    sunTransform.position.length !== 3 ||
    !sunTransform.position.every(Number.isFinite)
  ) {
    keyLight.position.copy(offlineSunDirection).multiplyScalar(sunLightDistance)
    return
  }

  sunDirection.set(...sunTransform.position)
  selectedBodyPosition.set(...bodyTransform.position)
  sunDirection.sub(selectedBodyPosition).applyMatrix4(kspToSceneTransform)
  if (sunDirection.lengthSq() === 0) return

  keyLight.position.copy(sunDirection.normalize()).multiplyScalar(sunLightDistance)
}

const flightStart = performance.now()
const demoEccentricity = demoOrbit.eccentricity

function createBodyTexture(body) {
  const width = 1024
  const height = 512
  const textureCanvas = document.createElement('canvas')
  textureCanvas.width = width
  textureCanvas.height = height
  const context = textureCanvas.getContext('2d')

  const colors = new THREE.Color(body.color)
  const baseColor = `#${colors.getHexString()}`
  context.fillStyle = baseColor
  context.fillRect(0, 0, width, height)

  let seed = body.id.split('').reduce((value, character) => value + character.charCodeAt(0), 0)
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }

  if (body.texture === 'star') {
    const glow = context.createLinearGradient(0, 0, 0, height)
    glow.addColorStop(0, '#d77b35')
    glow.addColorStop(0.48, '#ffe9a1')
    glow.addColorStop(1, '#e58a3d')
    context.fillStyle = glow
    context.fillRect(0, 0, width, height)
    for (let index = 0; index < 100; index += 1) {
      context.fillStyle = `rgba(255, 246, 184, ${0.08 + random() * 0.2})`
      context.beginPath()
      context.ellipse(random() * width, random() * height, 5 + random() * 30, 2 + random() * 9, random(), 0, Math.PI * 2)
      context.fill()
    }
  } else if (body.texture === 'gas') {
    for (let y = 0; y < height; y += 1) {
      const shade = Math.sin(y * 0.055) * 18 + Math.sin(y * 0.014) * 12
      context.fillStyle = `rgba(${Math.max(0, 90 + shade)}, ${Math.max(0, 125 + shade)}, ${Math.max(0, 96 + shade)}, 0.55)`
      context.fillRect(0, y, width, 1 + (random() > 0.94 ? 2 : 0))
    }
  } else {
    const isOcean = body.texture === 'ocean'
    const count = body.texture === 'barren' ? 34 : 76
    for (let index = 0; index < count; index += 1) {
      const x = random() * width
      const y = 24 + random() * (height - 48)
      const radius = 8 + random() * (isOcean ? 55 : 38)
      context.beginPath()
      context.ellipse(x, y, radius * (1.1 + random()), radius * (0.35 + random() * 0.6), random() * Math.PI, 0, Math.PI * 2)
      if (body.texture === 'barren') {
        context.fillStyle = `rgba(24, 21, 19, ${0.09 + random() * 0.13})`
        context.fill()
        context.strokeStyle = `rgba(235, 231, 210, ${0.12 + random() * 0.2})`
        context.lineWidth = 2 + random() * 4
        context.stroke()
      } else {
        context.fillStyle = isOcean
          ? `rgba(224, 234, 205, ${0.13 + random() * 0.32})`
          : `rgba(40, 28, 20, ${0.08 + random() * 0.2})`
        context.fill()
      }
    }
  }

  const texture = new THREE.CanvasTexture(textureCanvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function resize() {
  const { width, height } = canvas.getBoundingClientRect()
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

window.addEventListener('resize', resize)
resize()

const targetFrameInterval = 1000 / 60
let previousFrameTime = performance.now()
let previousRenderTime = 0
function renderFrame(frameTime) {
  if (frameTime - previousRenderTime < targetFrameInterval) return

  const deltaSeconds = Math.min((frameTime - previousFrameTime) / 1000, 0.1)
  previousFrameTime = frameTime
  previousRenderTime = frameTime

  if (!liveBodyOrientationActive) {
    bodySpinGroup.rotation.z += deltaSeconds * 0.06
  }

  if (!liveOrbitActive) {
    const elapsed = (frameTime - flightStart) / 1000
    const meanAnomaly = (elapsed * 0.12) % (Math.PI * 2)
    let eccentricAnomaly = meanAnomaly
    for (let iteration = 0; iteration < 5; iteration += 1) {
      eccentricAnomaly -=
        (eccentricAnomaly -
          demoEccentricity * Math.sin(eccentricAnomaly) -
          meanAnomaly) /
        (1 - demoEccentricity * Math.cos(eccentricAnomaly))
    }
    const trueAnomaly =
      2 *
      Math.atan2(
        Math.sqrt(1 + demoEccentricity) * Math.sin(eccentricAnomaly / 2),
        Math.sqrt(1 - demoEccentricity) * Math.cos(eccentricAnomaly / 2),
      )
    updateVesselMarker(trueAnomaly)
  }
  const vesselLocalPosition = vesselMarker.position
  surfaceTrackPosition
    .copy(vesselLocalPosition)
    .normalize()
    .multiplyScalar(planetRadius + 0.015)
  const trackPositions = surfaceTrackGeometry.attributes.position
  trackPositions.setXYZ(
    0,
    surfaceTrackPosition.x,
    surfaceTrackPosition.y,
    surfaceTrackPosition.z,
  )
  trackPositions.setXYZ(1, vesselLocalPosition.x, vesselLocalPosition.y, vesselLocalPosition.z)
  trackPositions.needsUpdate = true
  vesselMarker.getWorldPosition(vesselWorldPosition)
  followedPosition.lerp(vesselWorldPosition, 0.08)
  followedPositionDelta.copy(followedPosition).sub(controls.target)
  camera.position.add(followedPositionDelta)
  controls.target.copy(followedPosition)
  controls.update()
  cameraOutwardDirection.copy(followedPosition).normalize()
  if (cameraOutwardDirection.lengthSq() > 0) {
    const cameraOutwardDistance = camera.position.dot(cameraOutwardDirection)
    if (cameraOutwardDistance <= planetRadius + 0.1) {
      const cameraDistance = camera.position.distanceTo(followedPosition)
      cameraOutwardPosition
        .copy(followedPosition)
        .addScaledVector(cameraOutwardDirection, cameraDistance)
      camera.position.copy(cameraOutwardPosition)
      controls.update()
    }
  }
  camera.updateMatrixWorld()
  updateScreenSpaceMarker(vesselMarker, vesselWorldPosition, vesselMarkerDiameter, vesselMarkerScreenDiameter)
  const showVesselLabels = shouldShowVesselLabels()
  updateProjectedTag(
    periapsisTag,
    orbit.localToWorld(projectedPosition.copy(periapsisPosition)),
    showVesselLabels,
  )
  updateProjectedTag(
    apoapsisTag,
    orbit.localToWorld(projectedPosition.copy(apoapsisPosition)),
    showVesselLabels,
  )
  projectedPosition.copy(vesselWorldPosition).project(camera)
  setProjectedTagPosition(vesselTag, projectedPosition)
  vesselTag.hidden =
    !showVesselLabels ||
    projectedPosition.z < -1 ||
    projectedPosition.z > 1 ||
    Math.abs(projectedPosition.x) > 1 ||
    Math.abs(projectedPosition.y) > 1
  renderer.render(scene, camera)
}

renderer.setAnimationLoop(renderFrame)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null)
    return
  }
  previousFrameTime = performance.now()
  previousRenderTime = 0
  renderer.setAnimationLoop(renderFrame)
})

function updateScreenSpaceMarker(marker, worldPosition, geometryDiameter, screenDiameter) {
  const viewDepth = Math.max(
    camera.near,
    -markerViewPosition.copy(worldPosition).applyMatrix4(camera.matrixWorldInverse).z,
  )
  const visibleHeight = 2 * viewDepth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
  const worldDiameter = (visibleHeight * screenDiameter) / canvas.clientHeight
  marker.scale.setScalar(worldDiameter / geometryDiameter)
}

function updateProjectedTag(tag, worldPosition, isEnabled) {
  const screenPosition = projectedPosition.copy(worldPosition).project(camera)
  const isVisible =
    isEnabled &&
    screenPosition.z >= -1 &&
    screenPosition.z <= 1 &&
    Math.abs(screenPosition.x) <= 1 &&
    Math.abs(screenPosition.y) <= 1
  tag.hidden = !isVisible
  if (!isVisible) return

  setProjectedTagPosition(tag, screenPosition)
}

function setProjectedTagPosition(tag, screenPosition) {
  const left = `${Math.round(((screenPosition.x + 1) / 2) * canvas.clientWidth)}px`
  const top = `${Math.round(((1 - screenPosition.y) / 2) * canvas.clientHeight)}px`
  if (tag.style.left !== left) tag.style.left = left
  if (tag.style.top !== top) tag.style.top = top
}
