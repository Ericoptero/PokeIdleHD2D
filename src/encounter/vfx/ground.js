/**
 * ground.js — the ring a field move (and a super-effective hit, doubled) leaves on the floor.
 *
 * A flat disc lying on the XZ plane, `depthTest: true` on purpose — like the pixel-art field
 * glyph it replaces (`strikes.js`'s `FIELD_ART`), a ring on the ground *should* disappear
 * behind a hill; it is the one piece of this system that is not a billboard. The ring itself
 * is a procedural signed-distance shape in the fragment shader (a soft band at `uRadius`, no
 * texture), so its growth is a plain uniform rather than a second mesh swapped in.
 */

/** Half-width of the ring's plane, in world units — baked into the shader below so `p` (and
 *  therefore `uRadius`/`uThickness`) are plain world units, not the raw `[-1,1]` UV square. */
const PLANE_HALF = 2.4;

const RING_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColorA, uColorB;
uniform float uRadius, uThickness, uOpacity, uSecond;

float ring(vec2 p, float r, float w) {
  return smoothstep(w, 0.0, abs(length(p) - r));
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * ${PLANE_HALF.toFixed(2)};
  float d = length(p);
  if (d > ${PLANE_HALF.toFixed(2)}) discard;
  float a = ring(p, uRadius, uThickness) * uOpacity;
  // A super-effective hit gets a second, slightly larger, fainter ring a beat behind the first
  // rather than a bigger single one — reads as an echo, not just a size change.
  a += uSecond * ring(p, uRadius * 1.4, uThickness * 0.7) * uOpacity * 0.6;
  if (a <= 0.01) discard;
  vec3 col = mix(uColorB, uColorA, smoothstep(0.0, 1.0, 1.0 - abs(d - uRadius) / max(uThickness, 1e-3)));
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 */
export function makeGroundRing(THREE, scene) {
  const geo = new THREE.PlaneGeometry(PLANE_HALF * 2, PLANE_HALF * 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG,
    uniforms: {
      uRadius: { value: 0.3 }, uThickness: { value: 0.12 }, uOpacity: { value: 1 },
      uSecond: { value: 0 },
      uColorA: { value: new THREE.Color(0xffffff) }, uColorB: { value: new THREE.Color(0x888888) },
    },
    transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'encounter:vfx:ground';
  mesh.rotation.x = -Math.PI / 2;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.visible = false;
  scene.add(mesh);

  return {
    mesh,
    /** @param {{at:object,radius:number,thickness:number,opacity:number,second:number,colorA:string,colorB:string}} p */
    update(p) {
      mesh.visible = p.opacity > 0.001;
      mesh.position.set(p.at.x, p.at.y + 0.05, p.at.z);
      const u = mat.uniforms;
      u.uRadius.value = p.radius;
      u.uThickness.value = p.thickness;
      u.uOpacity.value = p.opacity;
      u.uSecond.value = p.second ?? 0;
      u.uColorA.value.set(p.colorA);
      u.uColorB.value.set(p.colorB);
    },
    hide() { mesh.visible = false; },
    dispose() { scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); },
  };
}
