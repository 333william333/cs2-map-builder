/**
 * Materials of the 3D preview: CS2-like terrain, roads with real markings, water, trees,
 * example houses and the zoning grid. All share the Atmosphere uniforms (sun, sky, haze).
 */
import * as THREE from 'three';
import { ATM_GLSL, patchMaterial, type Atmosphere } from './atmosphere';
import type { VertexGrid } from './terrainGrid';

// ---------------------------------------------------------------- height texture

/**
 * The rendered terrain mesh as a float texture (one texel per vertex) so shaders can drape
 * things on it or measure water depth with exactly the mesh's triangle interpolation.
 */
export function vertexGridTexture(v: VertexGrid): THREE.DataTexture {
  const tex = new THREE.DataTexture(v.data, v.n, v.n, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** GLSL: meshH(xz) with uniforms uHeight (vertex grid texture), uHeightN, uHeightExtent. */
export const MESH_HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHeightN;
uniform float uHeightExtent;
float meshH(vec2 xz) {
  float n = uHeightN;
  float d = uHeightExtent / (n - 1.0);
  vec2 f = clamp((xz + 0.5 * uHeightExtent) / d, vec2(0.0), vec2(n - 1.0));
  vec2 cr = min(floor(f), vec2(n - 2.0));
  vec2 u = f - cr;
  ivec2 i = ivec2(cr);
  float h00 = texelFetch(uHeight, i, 0).r;
  float h01 = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float h10 = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  if (u.x + u.y <= 1.0) return h00 + u.x * (h01 - h00) + u.y * (h10 - h00);
  return h11 + (1.0 - u.x) * (h10 - h11) + (1.0 - u.y) * (h01 - h11);
}
`;

export function heightUniforms(tex: THREE.DataTexture, v: VertexGrid): Record<string, THREE.IUniform> {
  return { uHeight: { value: tex }, uHeightN: { value: v.n }, uHeightExtent: { value: v.extentM } };
}

// ---------------------------------------------------------------- terrain

export interface TerrainMaterialInput {
  weightsA: THREE.Texture | null;
  weightsB: THREE.Texture | null;
  weightsSize: number;
  playExtent: number;
  snowLine: number;
  edgeFade?: [number, number];
  /** shared uniform: 1 tints the ground by land cover (reference only) */
  landcover?: THREE.IUniform<number>;
  key: string;
}

/**
 * GLSL: the ground as the game paints an imported map. Grass with natural variation, cliffs on
 * steep slopes, sand at sea shores (mud at lakes and rivers), snow by climate and altitude, a
 * darker forest floor under tree cover and the bed under water. No land cover input.
 * Needs ATM_GLSL and the uniforms uSnowLine, uSeaLevelY.
 */
export const GROUND_GLSL = /* glsl */ `
uniform float uSnowLine;

vec3 groundAlbedo(vec2 wp, float h, float ny, float above, float sea, float canopy, float depth, float fw) {
  float nLow = fbmAA(wp, 420.0, fw, 3);
  float nMid = fbmAA(wp, 48.0, fw, 3);
  float nFine = fbmAA(wp, 2.5, fw, 4);
  vec3 grassA = srgb(vec3(0.41, 0.47, 0.27));
  vec3 grassB = srgb(vec3(0.49, 0.51, 0.31));
  vec3 grassDry = srgb(vec3(0.60, 0.57, 0.38));
  vec3 c = mix(grassA, grassB, 0.3 + 0.4 * smoothstep(0.25, 0.75, nLow));
  c = mix(c, grassDry, smoothstep(0.62, 0.85, nMid) * 0.2);
  c *= 0.88 + 0.24 * nFine;
  float alt = smoothstep(260.0, 950.0, h - uSeaLevelY);
  c = mix(c, srgb(vec3(0.47, 0.46, 0.38)), alt * 0.6);
  c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.12);

  c = mix(c, srgb(vec3(0.30, 0.34, 0.20)) * (0.85 + 0.3 * nMid), canopy * 0.6);

  float sandAmt = sea * (1.0 - smoothstep(0.5, 1.8 + 1.6 * nMid, above));
  float mudAmt = (1.0 - sea) * (1.0 - smoothstep(0.1, 0.35 + 0.3 * nMid, above)) * 0.6;
  c = mix(c, srgb(vec3(0.79, 0.74, 0.59)) * (0.9 + 0.2 * nFine), sandAmt * (1.0 - canopy * 0.7));
  c = mix(c, srgb(vec3(0.47, 0.44, 0.36)) * (0.9 + 0.2 * nFine), mudAmt * (1.0 - canopy * 0.5));

  float rockAmt = smoothstep(0.86 + (nMid - 0.5) * 0.08, 0.76, ny);
  float strata = fbmAA(vec2(wp.x * 0.7 + wp.y * 0.7, h * 1.2), 9.0, fw, 3);
  float grit = fbmAA(wp + 77.0, 14.0, fw, 4);
  vec3 rock = mix(srgb(vec3(0.45, 0.43, 0.40)), srgb(vec3(0.60, 0.58, 0.54)), 0.55 * strata + 0.45 * grit) * (0.88 + 0.24 * nFine);
  c = mix(c, rock, rockAmt);

  float snowEdge = uSnowLine + (nLow - 0.5) * 140.0;
  float snow = smoothstep(snowEdge, snowEdge + 70.0, h) * smoothstep(0.45, 0.8, ny);
  c = mix(c, srgb(vec3(0.80, 0.83, 0.87)) * (0.93 + 0.1 * nFine), snow);

  if (depth > 0.0) {
    vec3 bed = mix(srgb(vec3(0.47, 0.47, 0.38)), srgb(vec3(0.10, 0.17, 0.20)), 1.0 - exp(-depth / 9.0));
    c = mix(c, bed, 1.0 - exp(-depth / 1.5));
  }
  return c;
}
`;

const TERRAIN_FRAG_DECL = /* glsl */ `
uniform sampler2D uWeightsA;
uniform sampler2D uWeightsB;
uniform float uWeightsSize;
uniform float uPlayExtent;
uniform float uHasWeights;
uniform float uLandcover;
varying vec4 vInfo;
varying vec3 vWN;
${GROUND_GLSL}

float sharpenW(float w, float n) { return smoothstep(0.18, 0.78, w + (n - 0.5) * 0.35); }

vec3 fieldColor(vec2 p, float fw) {
  vec2 q = vec2(p.x * 0.94 + p.y * 0.34, -p.x * 0.34 + p.y * 0.94);
  vec2 sz = vec2(250.0, 160.0);
  vec2 cell = floor(q / sz);
  float r = atmHash(cell + 7.0);
  float r2 = atmHash(cell + 19.0);
  vec3 col = r < 0.28 ? srgb(vec3(0.72, 0.66, 0.40))
    : r < 0.55 ? srgb(vec3(0.50, 0.56, 0.28))
    : r < 0.66 ? srgb(vec3(0.52, 0.46, 0.35))
    : r < 0.86 ? srgb(vec3(0.62, 0.62, 0.36))
    : srgb(vec3(0.44, 0.52, 0.27));
  vec2 f = fract(q / sz);
  float along = r2 < 0.5 ? q.x : q.y;
  float stripes = 0.5 + 0.5 * sin(along * 6.2831 / 3.2);
  float sAmp = (1.0 - smoothstep(0.35, 1.4, fw)) * 0.16;
  col *= 1.0 - sAmp + 2.0 * sAmp * stripes;
  vec2 edge = min(f, 1.0 - f) * sz;
  float e = min(edge.x, edge.y);
  float hedge = 1.0 - smoothstep(1.2, 1.2 + max(fw, 0.5) * 1.5, e);
  col = mix(col, srgb(vec3(0.33, 0.37, 0.21)), hedge * 0.55 * (1.0 - smoothstep(3.0, 10.0, fw)));
  col *= 0.93 + 0.14 * vnoise(p / 23.0 + r * 40.0);
  return col;
}

vec3 terrainAlbedo(out float canopy) {
  vec2 wp = vAtmW.xz;
  float h = vAtmW.y;
  float fw = max(length(fwidth(wp)), 1e-3);
  float texel = uPlayExtent / uWeightsSize;
  vec2 warp = vec2(vnoise(wp / 70.0), vnoise(wp / 70.0 + 31.7)) - 0.5;
  vec2 luv = (wp + warp * 1.6 * texel) / uPlayExtent + 0.5;
  float outside = max(max(-luv.x, luv.x - 1.0), max(-luv.y, luv.y - 1.0));
  float inside = (1.0 - smoothstep(-0.004, 0.0, outside)) * uHasWeights;
  vec4 wa = texture2D(uWeightsA, luv) * inside;
  vec4 wb = texture2D(uWeightsB, luv) * inside;
  // tree cover comes from the trees themselves, so it is part of the faithful look
  canopy = clamp(wb.b * 1.15, 0.0, 1.0);
  float ny = normalize(vWN).y;
  vec3 c = groundAlbedo(wp, h, ny, vInfo.x, vInfo.w, canopy, vInfo.y, fw);
  if (uLandcover > 0.5 && vInfo.y <= 0.0) {
    // reference only: the game does not receive land cover
    float nMid = fbmAA(wp, 48.0, fw, 3);
    float k = smoothstep(0.72, 0.9, ny);
    c = mix(c, srgb(vec3(0.43, 0.45, 0.27)) * (0.88 + 0.24 * nMid), sharpenW(wb.r, nMid) * k);
    c = mix(c, srgb(vec3(0.33, 0.40, 0.29)), sharpenW(wb.g, nMid) * 0.85 * k);
    float crop = sharpenW(wa.g, nMid) * k;
    if (crop > 0.002) c = mix(c, fieldColor(wp, fw), crop);
    c = mix(c, srgb(vec3(0.50, 0.52, 0.40)) * (0.9 + 0.2 * nMid), sharpenW(wa.b, nMid) * 0.5 * k);
    c = mix(c, srgb(vec3(0.50, 0.48, 0.43)) * (0.85 + 0.3 * nMid), sharpenW(wa.a, nMid) * k);
    c = mix(c, srgb(vec3(0.30, 0.34, 0.20)), sharpenW(wa.r, nMid) * 0.5 * k);
  }
  return c;
}
`;

export function makeTerrainMaterial(atm: Atmosphere, inp: TerrainMaterialInput): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const hasW = inp.weightsA && inp.weightsB ? 1 : 0;
  patchMaterial(mat, atm, {
    key: `terrain-${inp.key}-${inp.edgeFade ? 'fade' : 'nofade'}`,
    edgeFade: inp.edgeFade,
    uniforms: {
      uWeightsA: { value: inp.weightsA },
      uWeightsB: { value: inp.weightsB },
      uWeightsSize: { value: inp.weightsSize },
      uPlayExtent: { value: inp.playExtent },
      uSnowLine: { value: Number.isFinite(inp.snowLine) ? inp.snowLine : 1e9 },
      uHasWeights: { value: hasW },
      uLandcover: inp.landcover ?? { value: 0 },
    },
    vertexDecl: `attribute vec4 aInfo;
      varying vec4 vInfo;
      varying vec3 vWN;`,
    vertexReplace: {
      '#include <begin_vertex>': `#include <begin_vertex>
        vInfo = aInfo;
        vWN = normal;`,
    },
    fragmentDecl: TERRAIN_FRAG_DECL,
    fragmentReplace: {
      '#include <color_fragment>': `#include <color_fragment>
        float tCanopy = 0.0;
        diffuseColor.rgb = terrainAlbedo(tCanopy);`,
      '#include <aomap_fragment>': `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vInfo.z * (1.0 - tCanopy * 0.3);
        reflectedLight.directDiffuse *= mix(1.0, vInfo.z, 0.3) * (1.0 - tCanopy * 0.2);`,
    },
  });
  return mat;
}

/** 1x1 placeholder for materials that need a texture uniform. */
export function emptyTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export function weightsTexture(data: Uint8Array, size: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- roads

const ROAD_FRAG_DECL = /* glsl */ `
varying vec2 vRoadUv;
varying vec4 vRoadP;
varying float vRoadScale;

float aaLine(float dist, float width, float px) {
  float cover = clamp((0.5 * width - abs(dist)) / px + 0.5, 0.0, 1.0);
  return cover * clamp(width / px, 0.0, 1.0);
}
float dashes(float along, float on, float period) {
  return step(mod(along, period), on);
}

vec3 junctionSurface() {
  // uv.x = distance to the kerb line between two arms (large in the mouth of an arm)
  float kd = vRoadUv.x;
  float sw = vRoadP.y;
  vec2 sp = vAtmW.xz;
  float px = max(fwidth(kd), 1e-4);
  float grain = fbmAA(sp, 1.6, px, 3);
  vec3 c = srgb(vec3(0.30, 0.31, 0.32)) * (0.86 + 0.18 * grain);
  if (sw > 0.0) {
    float side = clamp((sw - kd) / px + 0.5, 0.0, 1.0);
    c = mix(c, srgb(vec3(0.66, 0.65, 0.61)) * (0.9 + 0.12 * grain), side);
    c = mix(c, srgb(vec3(0.80, 0.80, 0.77)), aaLine(kd - sw, 0.25, px));
  }
  return c;
}

vec3 roadSurface() {
  if (int(vRoadP.w + 0.5) == 8) return junctionSurface();
  float hw = vRoadP.x;
  float sw = vRoadP.y;
  float lanes = vRoadP.z;
  int kind = int(vRoadP.w + 0.5);
  float across = vRoadUv.x * hw;
  float along = vRoadUv.y;
  float ax = abs(across);
  float px = max(fwidth(across), 1e-4);
  float fwAlong = max(fwidth(along), 1e-4);
  float e = hw - ax;
  vec2 sp = vec2(across, along);
  float grain = fbmAA(sp, 1.6, px, 3);
  float patches = vnoise(sp / vec2(6.0, 23.0));
  vec3 asphalt = srgb(vec3(0.30, 0.31, 0.32)) * (0.86 + 0.18 * grain + 0.08 * patches);
  vec3 white = srgb(vec3(0.86, 0.86, 0.82));
  float dashVis = 1.0 - smoothstep(0.6, 2.5, fwAlong);
  vec3 c = asphalt;

  if (kind <= 1) {
    float dw = hw - sw;
    if (lanes >= 1.0) {
      float laneW = 2.0 * dw / max(lanes, 1.0);
      for (int k = 1; k < 6; k++) {
        if (float(k) >= lanes) break;
        float pos = -dw + float(k) * laneW;
        bool centre = kind == 0 && abs(float(k) - lanes * 0.5) < 0.1;
        float m;
        if (centre && lanes >= 4.0) m = max(aaLine(across - pos - 0.18, 0.15, px), aaLine(across - pos + 0.18, 0.15, px));
        else if (centre) m = aaLine(across - pos, 0.15, px) * mix(1.0, dashes(along, 3.0, 6.0), dashVis);
        else m = aaLine(across - pos, 0.13, px) * mix(0.5, dashes(along, 3.0, 9.0), dashVis);
        c = mix(c, white, m * 0.85);
      }
    }
    if (sw > 0.0) {
      float side = clamp((sw - e) / px + 0.5, 0.0, 1.0);
      float tiles = 0.92 + 0.08 * step(0.5, fract(along / 1.2)) * (1.0 - smoothstep(0.1, 0.4, fwAlong));
      vec3 walk = srgb(vec3(0.66, 0.65, 0.61)) * (0.9 + 0.12 * grain) * tiles;
      c = mix(c, walk, side);
      float kerb = aaLine(e - sw, 0.25, px);
      c = mix(c, srgb(vec3(0.80, 0.80, 0.77)), kerb);
      float gutter = aaLine(e - sw - 0.35, 0.3, px);
      c = mix(c, asphalt * 0.75, gutter * 0.6);
    }
  } else if (kind == 2) {
    c *= 1.05;
    float dw = hw - sw;
    float laneW = 2.0 * dw / max(lanes, 1.0);
    for (int k = 1; k < 6; k++) {
      if (float(k) >= lanes) break;
      float pos = -dw + float(k) * laneW;
      float m = aaLine(across - pos, 0.15, px) * mix(0.5, dashes(along, 4.0, 12.0), dashVis);
      c = mix(c, white, m * 0.85);
    }
    c = mix(c, white, aaLine(e - sw, 0.2, px) * 0.9);
    c = mix(c, c * 0.9, clamp((sw - e) / px + 0.5, 0.0, 1.0) * 0.5);
  } else if (kind == 3) {
    vec3 gravel = srgb(vec3(0.56, 0.50, 0.41)) * (0.85 + 0.25 * grain);
    float tracks = aaLine(ax - 1.1, 0.7, px);
    c = mix(gravel, gravel * 0.8, tracks);
  } else if (kind == 4) {
    c = srgb(vec3(0.66, 0.62, 0.55)) * (0.88 + 0.18 * grain);
  } else {
    // rail: ballast, sleepers and rails
    vec3 ballast = srgb(vec3(0.43, 0.40, 0.37)) * (0.8 + 0.35 * fbmAA(sp, 0.5, px, 3));
    c = kind == 7 ? asphalt : ballast;
    float tracks = kind == 5 ? 2.0 : 1.0;
    for (int t = 0; t < 2; t++) {
      if (float(t) >= tracks) break;
      float centre = tracks > 1.5 ? (t == 0 ? -2.25 : 2.25) : 0.0;
      float d = across - centre;
      float sleeperBand = clamp((1.3 - abs(d)) / px + 0.5, 0.0, 1.0);
      float sleeper = step(fract(along / 0.65), 0.42);
      float sVis = 1.0 - smoothstep(0.15, 0.5, fwAlong);
      vec3 wood = srgb(vec3(0.33, 0.27, 0.22));
      if (kind != 7) c = mix(c, mix(c * 0.8, wood, sleeper), sleeperBand * mix(0.5, 1.0, sVis));
      float rails = max(aaLine(d - 0.72, 0.09, px), aaLine(d + 0.72, 0.09, px));
      c = mix(c, srgb(vec3(0.62, 0.62, 0.64)), rails);
    }
  }
  return c;
}
`;

export function makeRoadMaterial(atm: Atmosphere, pxScale: THREE.IUniform<number>, key = 'road'): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  patchMaterial(mat, atm, {
    key,
    uniforms: { uPxScale: pxScale, uMinPx: { value: 1.6 } },
    vertexDecl: `attribute vec2 aRoadUv;
      attribute vec4 aRoadP;
      attribute vec3 aCenterOff;
      uniform float uPxScale;
      uniform float uMinPx;
      varying vec2 vRoadUv;
      varying vec4 vRoadP;
      varying float vRoadScale;`,
    vertexReplace: {
      '#include <begin_vertex>': `#include <begin_vertex>
        {
          float camD = distance(cameraPosition, position);
          float mpp = camD * uPxScale;
          float hwPx = aRoadP.x;
          float minHw = uMinPx * 0.5 * mpp;
          float s = max(1.0, minHw / max(hwPx, 0.1));
          transformed.xz += aCenterOff.xz * (s - 1.0);
          // depth bias along the view ray: keeps roads on top of coarse distant terrain
          vec3 toC = cameraPosition - transformed;
          transformed += toC / max(camD, 1e-3) * min(camD * 0.003, 50.0);
          vRoadScale = s;
          vRoadUv = aRoadUv;
          vRoadP = aRoadP;
        }`,
    },
    fragmentDecl: ROAD_FRAG_DECL,
    fragmentReplace: {
      '#include <color_fragment>': '#include <color_fragment>\ndiffuseColor.rgb = roadSurface();',
    },
  });
  return mat;
}

/**
 * Underground stretches (tunnels, subway) as a faded dashed guide on the surface. Uses the road
 * ribbon attributes and the same screen-space minimum width.
 */
export function makeTunnelMaterial(atm: Atmosphere, pxScale: THREE.IUniform<number>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    uniforms: { ...atm.uniforms, uPxScale: pxScale, uMinPx: { value: 2.0 } },
    vertexShader: /* glsl */ `
      attribute vec2 aRoadUv;
      attribute vec4 aRoadP;
      attribute vec3 aCenterOff;
      uniform float uPxScale;
      uniform float uMinPx;
      varying vec2 vUv;
      varying vec3 vW;
      void main() {
        vec3 p = position;
        float mpp = distance(cameraPosition, p) * uPxScale;
        float s = max(1.0, uMinPx * 0.5 * mpp / max(aRoadP.x, 0.1));
        p.xz += aCenterOff.xz * (s - 1.0);
        vec3 toC = cameraPosition - p;
        p += toC / max(length(toC), 1e-3) * min(length(toC) * 0.003 + 0.3, 50.0);
        vUv = aRoadUv;
        vW = p;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${ATM_GLSL}
      varying vec2 vUv;
      varying vec3 vW;
      void main() {
        float fwAlong = max(fwidth(vUv.y), 1e-3);
        float period = max(24.0, fwAlong * 18.0);
        float on = step(fract(vUv.y / period), 0.55);
        float edge = 1.0 - smoothstep(0.55, 1.0, abs(vUv.x));
        float a = on * mix(0.0, 0.5, edge);
        vec3 col = atmHaze(srgb(vec3(0.72, 0.80, 0.90)), vW);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---------------------------------------------------------------- simple lit materials

/** Lambert with haze: trees, bridges, outlines that should sit in the scene. */
export function makeLitMaterial(atm: Atmosphere, key: string, params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial(params);
  patchMaterial(mat, atm, { key });
  return mat;
}

/**
 * Example houses: wall colour from instanceColor, roof colour (flat roofs) from `iRoof`, and
 * procedural storeys and windows on the walls so the scale reads at street level.
 */
export function makeHouseMaterial(atm: Atmosphere, key: string): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patchMaterial(mat, atm, {
    key,
    vertexDecl: 'attribute vec3 iRoof;\nvarying vec3 vFacade;',
    vertexReplace: {
      '#include <color_vertex>': `#include <color_vertex>
        if (normal.y > 0.5) vColor.rgb = iRoof;
        {
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);
          float sz = length(instanceMatrix[2].xyz);
          // x: along the wall, y: metres above the base, z: 1 on walls
          vFacade = vec3(position.x * sx + position.z * sz, position.y * sy, abs(normal.y) < 0.5 ? 1.0 : 0.0);
        }`,
    },
    fragmentDecl: 'varying vec3 vFacade;',
    fragmentReplace: {
      '#include <color_fragment>': `#include <color_fragment>
        if (vFacade.z > 0.5) {
          vec2 f = vFacade.xy;
          vec2 fw = max(fwidth(f), vec2(1e-3));
          float vis = 1.0 - smoothstep(0.35, 1.2, max(fw.x, fw.y));
          float storey = 3.1;
          float yy = f.y - 1.2;
          float rowIn = smoothstep(0.30, 0.30 + fw.y / storey, fract(yy / storey)) * (1.0 - smoothstep(0.78 - fw.y / storey, 0.78, fract(yy / storey)));
          float colIn = smoothstep(0.22, 0.22 + fw.x / 2.6, fract(f.x / 2.6)) * (1.0 - smoothstep(0.78 - fw.x / 2.6, 0.78, fract(f.x / 2.6)));
          float win = rowIn * colIn * step(1.2, f.y) * vis;
          vec3 glass = srgb(vec3(0.20, 0.25, 0.30));
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85);
          diffuseColor.rgb *= 0.8 + 0.2 * smoothstep(0.0, 0.6, f.y);
        }`,
    },
  });
  return mat;
}

// ---------------------------------------------------------------- water

/**
 * Ground height for shaders that need water depth: GLSL defining `float groundH(vec2 xz)`
 * (return below -1e8 where unknown) plus its uniforms.
 */
export interface GroundHeight {
  glsl: string;
  uniforms: Record<string, THREE.IUniform>;
}

/** Ground height from the quick preview's vertex grid texture (inside the playable area only). */
export function meshGroundHeight(height: Record<string, THREE.IUniform>): GroundHeight {
  return {
    glsl: `${MESH_HEIGHT_GLSL}
      float groundH(vec2 xz) {
        if (max(abs(xz.x), abs(xz.y)) < 0.5 * uHeightExtent) return meshH(xz);
        return -1e9;
      }`,
    uniforms: height,
  };
}

/** GLSL: cell-centred bilinear lookup in a float grid texture (row 0 = north = smallest z). */
export const CELL_HEIGHT_GLSL = /* glsl */ `
float cellH(sampler2D tex, float n, float extent, vec2 xz) {
  vec2 f = (xz + 0.5 * extent) / extent * n - 0.5;
  f = clamp(f, vec2(0.0), vec2(n - 1.0));
  vec2 i0 = floor(f);
  vec2 u = f - i0;
  ivec2 a = ivec2(i0);
  ivec2 b = min(a + 1, ivec2(int(n) - 1));
  float h00 = texelFetch(tex, a, 0).r;
  float h10 = texelFetch(tex, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(tex, ivec2(a.x, b.y), 0).r;
  float h11 = texelFetch(tex, b, 0).r;
  return mix(mix(h00, h10, u.x), mix(h01, h11, u.x), u.y);
}
`;

export const TERRAIN_H_GLSL = /* glsl */ `
${CELL_HEIGHT_GLSL}
uniform sampler2D uPlayH;
uniform float uPlayN;
uniform float uPlayE;
uniform sampler2D uWorldH;
uniform float uWorldN;
uniform float uWorldE;
float terrainH(vec2 xz) {
  if (max(abs(xz.x), abs(xz.y)) <= 0.5 * uPlayE) return cellH(uPlayH, uPlayN, uPlayE, xz);
  return cellH(uWorldH, uWorldN, uWorldE, xz);
}
float groundH(vec2 xz) { return terrainH(xz); }
`;

/** Float texture of a cell grid for texelFetch lookups. */
export function floatTexture(data: Float32Array, n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.FloatType);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Ground height from cell grids of the playable area and the world (cell-centred bilinear). */
export function cellGroundHeight(
  playTex: THREE.Texture, playN: number, playE: number,
  worldTex: THREE.Texture, worldN: number, worldE: number,
): GroundHeight {
  return {
    glsl: TERRAIN_H_GLSL,
    uniforms: {
      uPlayH: { value: playTex }, uPlayN: { value: playN }, uPlayE: { value: playE },
      uWorldH: { value: worldTex }, uWorldN: { value: worldN }, uWorldE: { value: worldE },
    },
  };
}

export function makeWaterMaterial(
  atm: Atmosphere,
  ground: GroundHeight | null,
  opts: { edgeFade?: [number, number]; hq?: boolean; clipInside?: number; clipOutside?: number },
): THREE.ShaderMaterial {
  const useTex = ground ? 1 : 0;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...atm.uniforms,
      ...(ground?.uniforms ?? {}),
      uUseHeight: { value: useTex },
      uEdgeFade: { value: new THREE.Vector2(...(opts.edgeFade ?? [1e9, 2e9])) },
      uClip: { value: new THREE.Vector2(opts.clipInside ?? -1, opts.clipOutside ?? 1e9) },
    },
    defines: opts.hq ? { HQ: 1 } : {},
    vertexShader: /* glsl */ `
      attribute float aDepth;
      varying vec3 vW;
      varying float vDepth;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vDepth = aDepth;
        // pull towards the camera along the view ray (no change on screen) so coarse distant
        // terrain does not hide water that the full-resolution check in the fragment keeps
        vec3 toC = cameraPosition - w.xyz;
        float dC = length(toC);
        w.xyz += toC / max(dC, 1e-3) * min(dC * 0.003, 60.0);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${ATM_GLSL}
      ${ground ? ground.glsl : 'float groundH(vec2 xz) { return -1e9; }'}
      uniform float uUseHeight;
      uniform vec2 uEdgeFade;
      uniform vec2 uClip;
      varying vec3 vW;
      varying float vDepth;
      vec2 waveGrad(vec2 p) {
        float e = 0.08;
        float a = vnoise(p);
        return vec2(vnoise(p + vec2(e, 0.0)) - a, vnoise(p + vec2(0.0, e)) - a) / e;
      }
      void main() {
        float cheb = max(abs(vW.x), abs(vW.z));
        if (cheb < uClip.x || cheb > uClip.y) discard;
        float depth = vDepth;
        if (uUseHeight > 0.5) {
          float g = groundH(vW.xz);
          if (g > -1e8) depth = vW.y - g;
        }
        if (depth < -0.05) discard;
        depth = max(depth, 0.0);
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        float fw = max(length(fwidth(vW.xz)), 1e-3);
        vec2 p = vW.xz;
        float t = uTime;
        vec2 g = waveGrad(p / 26.0 + vec2(t * 0.03, t * 0.02)) * (1.0 - smoothstep(4.0, 20.0, fw))
               + waveGrad(p / 7.0 - vec2(t * 0.05, -t * 0.04)) * 0.5 * (1.0 - smoothstep(1.0, 5.0, fw))
               + waveGrad(p / 1.8 + vec2(t * 0.11, t * 0.07)) * 0.3 * (1.0 - smoothstep(0.25, 1.2, fw));
        vec3 N = normalize(vec3(-g.x * 0.07, 1.0, -g.y * 0.07));
        float ndv = max(dot(N, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y) + 0.01;
        vec3 refl = atmSky(normalize(R));
        float light = 0.3 + 0.9 * dot(uSunColor, vec3(0.333));
        vec3 shallow = srgb(vec3(0.22, 0.43, 0.42));
        vec3 deep = srgb(vec3(0.07, 0.19, 0.26));
        vec3 body = mix(shallow, deep, 1.0 - exp(-depth / 7.0)) * light;
        float alpha = clamp(1.0 - exp(-depth * 0.35), 0.0, 0.93);
        vec3 col = mix(body, refl, fres);
        alpha = mix(alpha, 1.0, fres * 0.9);
        float spec = pow(max(dot(normalize(R), uSunDir), 0.0), 380.0);
        col += uSunColor * spec * 5.0 * (1.0 - smoothstep(6.0, 40.0, fw));
        // shore foam
        float foamBand = 1.0 - smoothstep(0.0, 0.45 + fw * 0.08, depth);
        float fn = vnoise(p / 2.2 + vec2(t * 0.2, 0.0)) * 0.6 + vnoise(p / 0.7) * 0.4 * (1.0 - smoothstep(0.2, 0.8, fw));
        float foam = foamBand * smoothstep(0.35, 0.7, fn + foamBand * 0.25);
        // rivers and lakes have calm banks, the sea has surf
        float isSea = 1.0 - smoothstep(0.3, 1.5, abs(vW.y - uSeaLevelY));
        foam *= mix(0.25, 1.0, isSea);
        #ifndef HQ
          foam *= 0.6;
        #endif
        col = mix(col, srgb(vec3(0.92, 0.94, 0.94)) * light, foam * 0.8);
        alpha = max(alpha * smoothstep(0.0, 0.25, depth + 0.05), foam * 0.85);
        col = atmHaze(col, vW);
        float edgeF = smoothstep(uEdgeFade.x, uEdgeFade.y, max(abs(vW.x), abs(vW.z)));
        vec3 hd = normalize(vec3(vW.x - cameraPosition.x, 0.0, vW.z - cameraPosition.z) + vec3(0.0, 0.05, 0.0));
        col = mix(col, atmSky(hd) * 0.92, edgeF);
        alpha = mix(alpha, 1.0, edgeF);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  return mat;
}

// ---------------------------------------------------------------- zoning grid

export function makeZoneMaterial(atm: Atmosphere, height: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
    uniforms: { ...atm.uniforms, ...height },
    vertexShader: /* glsl */ `
      ${MESH_HEIGHT_GLSL}
      attribute vec4 iCell;
      attribute float iDepth;
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vW;
      void main() {
        vec2 dir = iCell.zw;
        vec2 side = vec2(-dir.y, dir.x);
        // scene z = -gz
        vec2 g = iCell.xy + dir * position.x * 8.0 + side * position.y * 8.0;
        vec2 xz = vec2(g.x, -g.y);
        float y = meshH(xz) + 0.35;
        vW = vec3(xz.x, y, xz.y);
        vUv = position.xy + 0.5;
        vDepth = iDepth;
        gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${ATM_GLSL}
      varying vec2 vUv;
      varying float vDepth;
      varying vec3 vW;
      void main() {
        vec2 px = max(fwidth(vUv), vec2(1e-4));
        vec2 e = min(vUv, 1.0 - vUv);
        // border line ~0.35 m wide, fades to a thinner hint when cells get tiny on screen
        vec2 lw = vec2(0.03);
        vec2 l = clamp((lw - e) / px + 0.5, 0.0, 1.0) * clamp(lw / px, 0.25, 1.0);
        float line = max(l.x, l.y);
        float far = smoothstep(0.08, 0.4, max(px.x, px.y));
        float fill = 0.22 - vDepth * 0.02;
        vec3 fillCol = srgb(vec3(0.93, 0.96, 0.92));
        vec3 lineCol = srgb(vec3(0.98, 1.0, 0.98));
        float light = 0.45 + 0.7 * dot(uSunColor, vec3(0.333));
        vec3 col = mix(fillCol, lineCol, line) * light;
        float a = mix(fill, 0.38, line);
        a = mix(a, 0.32 - vDepth * 0.03, far);
        col = atmHaze(col, vW);
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
