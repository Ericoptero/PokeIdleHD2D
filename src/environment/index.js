/**
 * environment — sky, sun, atmosphere and the per-time-of-day grade (ARCHITECTURE §5.3).
 *
 * The sun is placed from a real solar-position formula at a fictional latitude, so shadow
 * direction and length change through the day the way they do outdoors. That is what makes
 * the golden hour in docs/refs/04 read as light rather than as an orange filter.
 */

import * as THREE from 'three';
import { solarPosition, kelvinToRGB } from './sky.js';
import { PRESETS, blendPreset } from './presets.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uZenith, uHorizon, uGround, uSunColor, uSunDir;
uniform float uSunSize, uSunIntensity, uHaze, uStars;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;

  // Sky: horizon band widened by haze, ground below.
  float t = clamp(up, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(t, 0.45 + uHaze * 0.4));
  sky = mix(sky, uGround, smoothstep(0.0, -0.18, up));

  // Sun disc plus its aureole; the aureole is what sells depth at low angles.
  float cosA = dot(d, normalize(uSunDir));
  float disc = smoothstep(1.0 - uSunSize * 1.6, 1.0 - uSunSize * 0.4, cosA);
  float glow = pow(max(cosA, 0.0), 220.0) * 0.5 + pow(max(cosA, 0.0), 12.0) * 0.16;
  sky += uSunColor * (disc * uSunIntensity * 6.0 + glow * uSunIntensity);

  if (uStars > 0.001 && up > -0.02) {
    vec3 cell = floor(d * 260.0);
    float s = hash(cell);
    float star = smoothstep(0.9975, 1.0, s) * uStars * smoothstep(0.0, 0.25, up);
    sky += vec3(star) * (0.7 + 0.3 * hash(cell + 7.0));
  }
  gl_FragColor = vec4(max(sky, 0.0), 1.0);
}
`;

export default {
  id: 'environment',
  needs: [],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['tiles', 'terrain'],

  init(ctx) {
    const { config, bus, three, log } = ctx;
    const scene = three.scene;

    const skyUniforms = {
      uZenith: { value: new THREE.Color(0x3f7fd8) },
      uHorizon: { value: new THREE.Color(0xbcd8f0) },
      uGround: { value: new THREE.Color(0x1a2230) },
      uSunColor: { value: new THREE.Color(0xfff2d8) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunSize: { value: 0.012 },
      uSunIntensity: { value: 1 },
      uHaze: { value: 0.35 },
      uStars: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, uniforms: skyUniforms,
        // Painted first with no depth interaction at all: a sky pinned to the far plane
        // fails a LESS depth test against a cleared buffer and silently disappears.
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
      }),
    );
    sky.name = 'sky';
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    sky.scale.setScalar(200);
    scene.add(sky);

    const hemi = new THREE.HemisphereLight(0xbcd8f0, 0x2a3320, 1.0);
    hemi.name = 'hemi';
    scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(ambient);

    scene.fog = new THREE.FogExp2(0xbcd8f0, 0.012);

    let tod = config.tod;
    let biome = 'meadow';
    let weather = { name: 'clear', intensity: 0 };
    let phase = 'day';

    function phaseOf(t) {
      if (t < 5 || t >= 20.5) return 'night';
      if (t < 6.8) return 'dawn';
      if (t < 8.5) return 'morning';
      if (t < 16.5) return 'day';
      if (t < 18.6) return 'goldenHour';
      return 'dusk';
    }

    function apply() {
      const sun = solarPosition(tod, config.latitude);
      const preset = blendPreset(tod, PRESETS[biome] ?? PRESETS.meadow);

      // Direction from the world toward the sun. Below the horizon we light from the moon,
      // which sits opposite and is far cooler and dimmer.
      const isNight = sun.altitude < -0.03;
      const dir = isNight
        ? new THREE.Vector3(-sun.dir.x, Math.max(0.35, -sun.dir.y), -sun.dir.z).normalize()
        : new THREE.Vector3(sun.dir.x, Math.max(0.08, sun.dir.y), sun.dir.z).normalize();

      // Colour temperature falls off hard near the horizon: 6500K overhead, 2100K at set.
      const h = Math.max(0, Math.min(1, (sun.altitude + 0.05) / 0.55));
      const kelvin = 2100 + h * 4400;
      const sunColor = isNight ? new THREE.Color(0x9fb6e8) : kelvinToRGB(kelvin);
      const sunIntensity = isNight
        ? 0.42
        : THREE.MathUtils.lerp(0.35, 3.5, Math.pow(Math.max(0, Math.sin(Math.max(sun.altitude, 0))), 0.55));

      three.sun.setDirection(dir.x, dir.y, dir.z);
      three.sun.light.color.copy(sunColor);
      three.sun.light.intensity = sunIntensity * preset.sunScale;

      hemi.color.copy(preset.skyHorizon);
      hemi.groundColor.copy(preset.ground);
      hemi.intensity = preset.hemi;
      ambient.intensity = preset.ambient;

      skyUniforms.uZenith.value.copy(preset.skyZenith);
      skyUniforms.uHorizon.value.copy(preset.skyHorizon);
      skyUniforms.uGround.value.copy(preset.ground);
      skyUniforms.uSunColor.value.copy(sunColor);
      skyUniforms.uSunDir.value.copy(dir);
      skyUniforms.uSunIntensity.value = isNight ? 0.15 : Math.max(0.2, sunIntensity * 0.35);
      skyUniforms.uHaze.value = preset.haze + weather.intensity * 0.4;
      skyUniforms.uStars.value = isNight ? Math.min(1, (-sun.altitude - 0.03) * 4) : 0;

      scene.fog.color.copy(preset.fog);
      scene.fog.density = preset.fogDensity * (1 + weather.intensity * 2.5);

      const grade = three.view.grade;
      grade.uLift.value.set(preset.lift.r, preset.lift.g, preset.lift.b);
      grade.uGain.value.set(preset.gain.r, preset.gain.g, preset.gain.b);
      config.set({
        exposure: preset.exposure,
        bloomStrength: preset.bloom,
        bloomThreshold: preset.bloomThreshold,
        saturation: preset.saturation,
      });

      const p = phaseOf(tod);
      if (p !== phase) { phase = p; bus.emit('tod:changed', { tod, phase }); }
    }

    apply();

    return {
      setTimeOfDay(t) {
        tod = ((Number(t) % 24) + 24) % 24;
        apply();          // apply() emits tod:changed only when the phase actually turns over
      },
      getTimeOfDay: () => tod,
      phase: () => phaseOf(tod),
      setBiomePreset(name) { if (PRESETS[name]) { biome = name; apply(); } else log.warn(`no environment preset "${name}"`); },
      biome: () => biome,
      setWeather(name, intensity = 0.5) { weather = { name, intensity: Math.max(0, Math.min(1, intensity)) }; apply(); },
      weather: () => ({ ...weather }),
      sun: () => {
        const s = solarPosition(tod, config.latitude);
        return { ...s, color: three.sun.light.color.getHex(), intensity: three.sun.light.intensity };
      },
      tune(patch) { config.set(patch); apply(); },
      presets: () => Object.keys(PRESETS),
      skyUniforms,
      /** Camera framings the screenshot harness can request. */
      preset(name) {
        const t = { dawn: 6.2, morning: 8, noon: 12, golden: 17.8, dusk: 19.4, night: 22.5 }[name];
        if (t === undefined) return false;
        this.setTimeOfDay(t);
        return true;
      },
    };
  },

  tick(dt, ctx) {
    const { config } = ctx;
    if (config.timeFrozen) return;
    const env = ctx.get('environment');
    const perHour = Math.max(1e-3, config.secondsPerGameHour);
    env.setTimeOfDay(env.getTimeOfDay() + dt / perHour);
  },

  async showcase(mode, ctx) {
    const { showcaseEnvironment } = await import('./showcase.js');
    return showcaseEnvironment(mode, ctx);
  },
};
