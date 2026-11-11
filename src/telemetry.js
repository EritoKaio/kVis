import './style.css'
import * as THREE from 'three'

const velocityGauge = document.querySelector('[data-gauge="velocity"]')
const altitudeGauge = document.querySelector('[data-gauge="altitude"]')
const velocityValue = document.querySelector('#velocity-value')
const altitudeValue = document.querySelector('#altitude-value')
const gForceValue = document.querySelector('#gforce-value')
const telemetryStatus = document.querySelector('#telemetry-status')
const orientationCanvas = document.querySelector('#orientation-canvas')
const fallbackAtmosphereDepth = 70_000
let connectionFailureLogged = false

const orientationRenderer = new THREE.WebGLRenderer({
  canvas: orientationCanvas,
  alpha: true,
  antialias: true,
})
orientationRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
orientationRenderer.setClearColor(0x000000, 0)
orientationRenderer.outputColorSpace = THREE.SRGBColorSpace

const orientationScene = new THREE.Scene()
const orientationCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 20)
orientationCamera.position.set(0, 0, 4.2)
const orientationFrame = new THREE.Group()
orientationFrame.rotation.x = -Math.PI / 6
orientationScene.add(orientationFrame)
const orientationGuide = new THREE.Group()
orientationFrame.add(orientationGuide)

const guideMaterial = new THREE.LineBasicMaterial({
  color: '#8492a8',
  transparent: true,
  opacity: 0.38,
})

const globeOutline = new THREE.Mesh(
  new THREE.TorusGeometry(1.34, 0.012, 6, 96),
  guideMaterial,
)
orientationGuide.add(globeOutline)

const equatorialPlane = new THREE.Group()
equatorialPlane.rotation.x = Math.PI / 2
orientationGuide.add(equatorialPlane)

const equatorialDisk = new THREE.Mesh(
  new THREE.CircleGeometry(1.18, 96),
  new THREE.MeshBasicMaterial({
    color: '#91a5bf',
    transparent: true,
    opacity: 0.045,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
)
equatorialPlane.add(equatorialDisk)

const equatorialRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.18, 0.014, 6, 96),
  new THREE.MeshBasicMaterial({
    color: '#b2c1d5',
    transparent: true,
    opacity: 0.72,
  }),
)
equatorialPlane.add(equatorialRing)

orientationScene.add(new THREE.AmbientLight('#aab7ca', 1.5))
const orientationLight = new THREE.DirectionalLight('#ffffff', 3)
orientationLight.position.set(-2, 3, 4)
orientationScene.add(orientationLight)

const vehicle = new THREE.Group()
orientationFrame.add(vehicle)
const vehicleModel = new THREE.Group()
vehicleModel.rotation.x = Math.PI / 2
vehicle.add(vehicleModel)

const arrowShaft = new THREE.Mesh(
  new THREE.CylinderGeometry(0.085, 0.11, 0.92, 12),
  new THREE.MeshStandardMaterial({
    color: '#e8edf5',
    metalness: 0.28,
    roughness: 0.36,
  }),
)
arrowShaft.position.y = -0.27
vehicleModel.add(arrowShaft)

const arrowhead = new THREE.Mesh(
  new THREE.ConeGeometry(0.39, 0.62, 4, 1),
  new THREE.MeshStandardMaterial({
    color: '#ff604f',
    emissive: '#76180f',
    emissiveIntensity: 0.35,
    metalness: 0.12,
    roughness: 0.34,
  }),
)
arrowhead.position.y = 0.48
arrowhead.rotation.y = Math.PI / 4
vehicleModel.add(arrowhead)

const arrowTail = new THREE.Mesh(
  new THREE.BoxGeometry(0.24, 0.1, 0.24),
  new THREE.MeshStandardMaterial({
    color: '#70b7ff',
    metalness: 0.2,
    roughness: 0.4,
  }),
)
arrowTail.position.y = -0.76
vehicleModel.add(arrowTail)

const kspToSceneTransform = new THREE.Matrix4().set(
  1, 0, 0, 0,
  0, 0, 1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
)
const attitudeMatrix = new THREE.Matrix4()
const viewMatrix = new THREE.Matrix4()
const targetAttitude = new THREE.Quaternion()
const viewAttitude = new THREE.Quaternion()
const bodyNorth = new THREE.Vector3(0, 0, 1)
const viewRight = new THREE.Vector3()
const viewForward = new THREE.Vector3()
const kspVector = new THREE.Vector3()
const fallbackRight = new THREE.Vector3()
const identityAttitude = new THREE.Quaternion()

function resizeOrientationView() {
  const size = orientationCanvas.clientWidth
  if (size === 0) return
  orientationRenderer.setSize(size, size, false)
  orientationCamera.aspect = 1
  orientationCamera.updateProjectionMatrix()
}

function updateAttitude(attitude, velocity, position) {
  if (
    !Array.isArray(attitude) ||
    attitude.length !== 4 ||
    !attitude.every(Number.isFinite) ||
    !Array.isArray(velocity) ||
    velocity.length !== 3 ||
    !velocity.every(Number.isFinite)
  ) {
    return
  }

  kspVector.fromArray(velocity).applyMatrix4(kspToSceneTransform)
  viewRight.copy(kspVector).addScaledVector(bodyNorth, -kspVector.dot(bodyNorth))
  if (viewRight.lengthSq() < 1e-8 && Array.isArray(position) && position.length === 3) {
    kspVector.fromArray(position).applyMatrix4(kspToSceneTransform)
    viewRight.copy(kspVector).addScaledVector(bodyNorth, -kspVector.dot(bodyNorth))
  }
  if (viewRight.lengthSq() < 1e-8) {
    fallbackRight.set(1, 0, 0)
    viewRight.copy(fallbackRight)
  }
  viewRight.normalize()
  viewForward.crossVectors(viewRight, bodyNorth).normalize()
  viewMatrix.makeBasis(viewRight, bodyNorth, viewForward)
  viewAttitude.setFromRotationMatrix(viewMatrix).invert()

  const kspAttitude = new THREE.Quaternion(...attitude).normalize()
  attitudeMatrix.makeRotationFromQuaternion(kspAttitude)
  attitudeMatrix.premultiply(kspToSceneTransform).multiply(kspToSceneTransform)
  targetAttitude
    .setFromRotationMatrix(attitudeMatrix)
    .premultiply(viewAttitude)
    .normalize()
}

function renderOrientation() {
  vehicle.quaternion.slerp(targetAttitude, 0.16)
  orientationRenderer.render(orientationScene, orientationCamera)
  window.requestAnimationFrame(renderOrientation)
}

window.addEventListener('resize', resizeOrientationView)
resizeOrientationView()
renderOrientation()

function setGaugeProgress(gauge, progress) {
  const clampedProgress = Math.max(0, Math.min(1, progress))
  gauge.style.setProperty('--gauge-progress', clampedProgress * 75)
}

function resetReadings(status) {
  velocityValue.textContent = '--'
  altitudeValue.textContent = '--'
  gForceValue.textContent = '--'
  setGaugeProgress(velocityGauge, 0)
  setGaugeProgress(altitudeGauge, 0)
  targetAttitude.copy(identityAttitude)
  telemetryStatus.textContent = status
}

function connectTelemetry() {
  const telemetrySocket = new WebSocket('ws://127.0.0.1:5174')

  telemetrySocket.addEventListener('open', () => {
    connectionFailureLogged = false
    resetReadings('CONNECTING TO KSP')
  })

  telemetrySocket.addEventListener('message', (event) => {
    let telemetry
    try {
      telemetry = JSON.parse(event.data)
    } catch (error) {
      console.error('Received invalid telemetry from the local kRPC bridge', error)
      return
    }

    if (telemetry.state !== 'connected') {
      resetReadings(telemetry.state === 'no-vessel' ? 'NO ACTIVE VESSEL' : 'CONNECTING TO KSP')
      return
    }

    const orbit = telemetry.orbit
    const altitude = telemetry.altitude
    const speed = telemetry.speed
    const atmosphereDepth = orbit?.atmosphereDepth
    const gravityParameter = orbit?.gravitationalParameter
    const bodyRadius = orbit?.bodyRadius
    const altitudeRange =
      Number.isFinite(atmosphereDepth) && atmosphereDepth > 0
        ? atmosphereDepth
        : fallbackAtmosphereDepth

    velocityValue.textContent = Number.isFinite(speed)
      ? Math.round(speed * 3.6).toLocaleString('en-US')
      : '--'
    altitudeValue.textContent = Number.isFinite(altitude) ? (altitude / 1000).toFixed(1) : '--'
    gForceValue.textContent = Number.isFinite(telemetry.gForce) ? telemetry.gForce.toFixed(1) : '--'
    setGaugeProgress(altitudeGauge, Number.isFinite(altitude) ? altitude / altitudeRange : 0)

    const orbitTargetSpeed =
      Number.isFinite(gravityParameter) &&
      gravityParameter > 0 &&
      Number.isFinite(bodyRadius) &&
      bodyRadius > 0 &&
      Number.isFinite(atmosphereDepth)
        ? Math.sqrt(gravityParameter / (bodyRadius + Math.max(0, atmosphereDepth)))
        : Number.NaN
    setGaugeProgress(
      velocityGauge,
      Number.isFinite(speed) && Number.isFinite(orbitTargetSpeed) && orbitTargetSpeed > 0
        ? speed / orbitTargetSpeed
        : 0,
    )

    updateAttitude(telemetry.attitude, telemetry.velocity, telemetry.position)
    telemetryStatus.textContent = telemetry.vesselName || 'LIVE TELEMETRY'
  })

  telemetrySocket.addEventListener('error', (error) => {
    if (!connectionFailureLogged) {
      console.error('Could not connect to the local kRPC bridge at ws://127.0.0.1:5174', error)
      connectionFailureLogged = true
    }
  })

  telemetrySocket.addEventListener('close', () => {
    resetReadings('WAITING FOR BRIDGE')
    window.setTimeout(connectTelemetry, 2000)
  })
}

connectTelemetry()
