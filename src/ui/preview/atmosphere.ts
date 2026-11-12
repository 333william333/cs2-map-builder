/**
 * Shared sky, sun and aerial-perspective state for every preview material, plus the GLSL that
 * uses it. All materials hold references to the same uniform objects, so changing the time of
 * day updates sky, haze, water and lights together.
 */
import * as THREE from 'three';
import { skyPalette, sunPosition, summerDay, type SunState } from './sun';

export interface AtmUniforms {
  [k: string]: THREE.IUniform;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Vector3>;
  uSkyZenith: THREE.IUniform<THREE.Vector3>;
  uSkyHorizon: THREE.IUniform<THREE.Vector3>;
  uHazeDensity: THREE.IUniform<number>;
  uHazeFalloff: THREE.IUniform<number>;
  uSeaLevelY: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
}

/** GLSL: value noise, fbm, sky colour and aerial perspective. Needs the uniforms above. */
export const ATM_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uHazeDensity;
uniform float uHazeFalloff;
uniform float uSeaLevelY;
uniform float uTime;

float atmHash(vec2 p) {
  p = mod(p, 4096.0);
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = atmHash(i);
  float b = atmHash(i + vec2(1.0, 0.0));
  float c = atmHash(i + vec2(0.0, 1.0));
  float d = atmHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
/** fbm whose octaves fade out once they get smaller than a pixel (fw = metres per pixel). */
float fbmAA(vec2 p, float scale, float fw, int octaves) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  float s = scale;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    float k = 1.0 - smoothstep(0.25, 0.7, fw / s);
    sum += amp * k * (vnoise(p / s + float(i) * 17.3) - 0.5);
    norm += amp;
    amp *= 0.5;
    s *= 0.5;
  }
  return 0.5 + sum / max(norm, 1e-4);
}
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

vec3 atmSky(vec3 dir) {
  float y = dir.y;
  float t = pow(clamp(y, 0.0, 1.0), 0.42);
  vec3 c = mix(uSkyHorizon, uSkyZenith, t);
  if (y < 0.0) c = mix(uSkyHorizon, uSkyHorizon * 0.82, clamp(-y * 3.0, 0.0, 1.0));
  float mu = max(dot(dir, uSunDir), 0.0);
  c += uSunColor * (0.10 * pow(mu, 5.0) + 0.28 * pow(mu, 48.0));
  return c;
}

vec3 atmHaze(vec3 col, vec3 wpos) {
  vec3 v = wpos - cameraPosition;
  float d = length(v);
  vec3 dir = v / max(d, 1e-3);
  float h0 = max(cameraPosition.y - uSeaLevelY, 0.0);
  float k = dir.y * uHazeFalloff;
  float integral = abs(k) > 1e-6 ? (1.0 - exp(-d * k)) / k : d;
  float amount = uHazeDensity * exp(-h0 * uHazeFalloff) * integral;
  float f = 1.0 - exp(-max(amount, 0.0));
  vec3 dh = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.4 + 0.03, dir.z));
  return mix(col, atmSky(dh) * 0.85, f);
}
`;

const VERT_DECL = /* glsl */ `
varying vec3 vAtmW;
`;
const VERT_BODY = /* glsl */ `
  {
    vec4 atmP = vec4(transformed, 1.0);
    #ifdef USE_INSTANCING
      atmP = instanceMatrix * atmP;
    #endif
    vAtmW = (modelMatrix * atmP).xyz;
  }
`;

export interface PatchOptions {
  /** extra GLSL declarations for both stages */
  vertexDecl?: string;
  fragmentDecl?: string;
  /** replaces / extends shader chunks: { '#include <x>': 'code' } */
  vertexReplace?: Record<string, string>;
  fragmentReplace?: Record<string, string>;
  uniforms?: Record<string, THREE.IUniform>;
  /** fade the colour into the horizon towards the world edge: [start, end] in |x|,|z| metres */
  edgeFade?: [number, number];
  /** program cache key; must differ between differently patched materials */
  key: string;
}

/**
 * Adds aerial perspective (and optional extra shader code) to a built-in lit material.
 * The haze is applied in linear HDR before tone mapping, so it works on screen and in the
 * offscreen render the same way.
 */
export function patchMaterial(mat: THREE.Material, atm: Atmosphere, opts: PatchOptions): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atm.uniforms);
    if (opts.uniforms) Object.assign(shader.uniforms, opts.uniforms);
    if (opts.edgeFade) shader.uniforms.uEdgeFade = { value: new THREE.Vector2(opts.edgeFade[0], opts.edgeFade[1]) };
    let vs = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${VERT_DECL}\n${opts.vertexDecl ?? ''}`,
    );
    for (const [k, v] of Object.entries(opts.vertexReplace ?? {})) vs = vs.replace(k, v);
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
    let fs = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\nvarying vec3 vAtmW;\n${ATM_GLSL}\n${opts.edgeFade ? 'uniform vec2 uEdgeFade;' : ''}\n${opts.fragmentDecl ?? ''}`,
    );
    for (const [k, v] of Object.entries(opts.fragmentReplace ?? {})) fs = fs.replace(k, v);
    const fade = opts.edgeFade
      ? `{
          float edgeF = smoothstep(uEdgeFade.x, uEdgeFade.y, max(abs(vAtmW.x), abs(vAtmW.z)));
          vec3 hd = normalize(vec3(vAtmW.x - cameraPosition.x, 0.0, vAtmW.z - cameraPosition.z) + vec3(0.0, 0.05, 0.0));
          outgoingLight = mix(outgoingLight, atmSky(hd) * 0.92, edgeF);
        }`
      : '';
    fs = fs.replace(
      '#include <opaque_fragment>',
      `outgoingLight = atmHaze(outgoingLight, vAtmW);\n${fade}\n#include <opaque_fragment>`,
    );
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => opts.key;
}

/** Sun, sky and lights. One per engine; materials reference `uniforms`. */
export class Atmosphere {
  readonly uniforms: AtmUniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uSkyZenith: { value: new THREE.Vector3(0.1, 0.25, 0.6) },
    uSkyHorizon: { value: new THREE.Vector3(0.6, 0.7, 0.8) },
    uHazeDensity: { value: 1.6e-5 },
    uHazeFalloff: { value: 1 / 1400 },
    uSeaLevelY: { value: 0 },
    uTime: { value: 0 },
  };
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  state: SunState;
  latitude = 60;
  rotationDeg = 0;
  hour = 15.5;

  constructor() {
    this.state = sunPosition(60, 196, 15.5);
    this.apply();
  }

  /** Sets latitude/rotation (from the result) and the local solar hour; summer day. */
  set(latitude: number, rotationDeg: number, hour: number): void {
    this.latitude = latitude;
    this.rotationDeg = rotationDeg;
    this.hour = hour;
    this.state = sunPosition(latitude, summerDay(latitude), hour, rotationDeg);
    this.apply();
  }

  private apply(): void {
    const s = this.state;
    const pal = skyPalette(s.elevationDeg);
    const u = this.uniforms;
    // keep a light direction slightly above the horizon so terrain never goes fully black
    const d = new THREE.Vector3(...s.dir);
    if (d.y < 0.03) {
      d.y = 0.03;
      d.normalize();
    }
    u.uSunDir.value.copy(d);
    u.uSunColor.value.set(...pal.sun);
    u.uSkyZenith.value.set(...pal.zenith);
    u.uSkyHorizon.value.set(...pal.horizon);
    // lights: three's lambert divides by PI, so intensities are around PI for "1"
    this.sun.color.setRGB(pal.sun[0], pal.sun[1], pal.sun[2], THREE.LinearSRGBColorSpace);
    this.sun.intensity = 3.3;
    this.hemi.color.setRGB(pal.ambientSky[0], pal.ambientSky[1], pal.ambientSky[2], THREE.LinearSRGBColorSpace);
    this.hemi.groundColor.setRGB(pal.ambientGround[0], pal.ambientGround[1], pal.ambientGround[2], THREE.LinearSRGBColorSpace);
    this.hemi.intensity = 1.55;
  }

  /** Places the directional light `dist` metres from `target` along the sun direction. */
  aimSun(target: THREE.Vector3, dist: number): void {
    this.sun.position.copy(target).addScaledVector(this.uniforms.uSunDir.value, dist);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }
}

/** Sky dome with a visible sun disk. */
export function buildSkyDome(atm: Atmosphere): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: atm.uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${ATM_GLSL}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = atmSky(d);
        float mu = dot(d, uSunDir);
        c += uSunColor * smoothstep(0.99955, 0.99975, mu) * 40.0;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.toneMapped = true;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300_000, 32, 16), mat);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  return mesh;
}
