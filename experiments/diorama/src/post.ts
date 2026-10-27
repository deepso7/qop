import {
  HalfFloatType,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from "three";
import type { Camera, Material, WebGLRenderer } from "three";

import { palette } from "./palette";
import { isKind } from "./voxel";
import type { Kind } from "./voxel";

/** Camera layer for shadow decals, which only the light pass sees. */
export const BLOB_LAYER = 1;

/** Size of the low-res render. The canvas is shown at a whole multiple of this. */
export const RES = 192;

// Dithered light levels: full sun, shade, shadow. Face brightnesses from the
// sun sit between these on purpose so the sides come out stippled.
const LEVELS = [0.5, 0.74, 1] as const;

const target = () =>
  new WebGLRenderTarget(RES, RES, {
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  });

const white = { color: 0xff_ff_ff };

const albedoMaterials: Record<Kind, Material> = {
  solid: new MeshBasicMaterial(white),
  glow: new MeshBasicMaterial(white),
  // Never drawn: blobs live on BLOB_LAYER, which this pass hides.
  blob: new MeshBasicMaterial(white),
};

const lightMaterials: Record<Kind, Material> = {
  solid: new MeshLambertMaterial(white),
  glow: new MeshBasicMaterial(white),
  blob: new MeshBasicMaterial({
    color: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  }),
};

/** A palette hex as a GLSL `r, g, b` literal. */
const hexToVec = (hex: number) =>
  [16, 8, 0].map((s) => (((hex >> s) & 255) / 255).toFixed(4)).join(", ");

const { ink } = palette;

/** Points every tagged mesh at the material for its kind in this pass. */
const assign = (scene: Scene, materials: Record<Kind, Material>) =>
  scene.traverse((o) => {
    const kind: unknown = o.userData.kind;

    if (o instanceof Mesh && isKind(kind)) {
      o.material = materials[kind];
    }
  });

const shader = new ShaderMaterial({
  uniforms: {
    albedo: { value: null },
    light: { value: null },
    res: { value: new Vector2(RES, RES) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D albedo;
    uniform sampler2D light;
    uniform vec2 res;
    varying vec2 vUv;

    float bayer4(vec2 p) {
      ivec2 i = ivec2(mod(p, 4.0));
      int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      return (float(m[i.y * 4 + i.x]) + 0.5) / 16.0;
    }

    float level(float v, float threshold) {
      const float L0 = ${LEVELS[0].toFixed(3)};
      const float L1 = ${LEVELS[1].toFixed(3)};
      const float L2 = ${LEVELS[2].toFixed(3)};
      if (v <= L0) return L0;
      if (v < L1) return (v - L0) / (L1 - L0) > threshold ? L1 : L0;
      if (v < L2) return (v - L1) / (L2 - L1) > threshold ? L2 : L1;
      return L2;
    }

    void main() {
      vec4 a = texture2D(albedo, vUv);
      if (a.a < 0.5) {
        // 1px ink outline around the silhouette, so it holds up on white.
        vec2 px = 1.0 / res;
        float edge = texture2D(albedo, vUv + vec2(px.x, 0.0)).a + texture2D(albedo, vUv - vec2(px.x, 0.0)).a
                   + texture2D(albedo, vUv + vec2(0.0, px.y)).a + texture2D(albedo, vUv - vec2(0.0, px.y)).a;
        gl_FragColor = edge > 0.5 ? vec4(vec3(${hexToVec(ink)}), 1.0) : vec4(0.0);
        return;
      }
      vec3 l = texture2D(light, vUv).rgb;
      float base = max(max(a.r, a.g), a.b);
      float v = max(max(l.r, l.g), l.b) / max(base, 1e-3);
      gl_FragColor = vec4(a.rgb * level(v, bayer4(gl_FragCoord.xy)), 1.0);
    }
  `,
});

/**
 * Renders the scene twice at RES: once flat (palette colour) and once as
 * white-lit Lambert with shadows (how much light lands there). The final pass
 * divides the two, snaps the light to a few Bayer-dithered levels, and writes
 * palette colour × level to the canvas, which CSS scales up with nearest
 * neighbour.
 */
export const createPost = (renderer: WebGLRenderer) => {
  const albedo = target();
  const light = target();
  const quad = new Mesh(new PlaneGeometry(2, 2), shader);
  const quadScene = new Scene();
  quadScene.add(quad);
  const quadCamera = new OrthographicCamera();

  return (scene: Scene, camera: Camera) => {
    renderer.setClearColor(0, 0);
    camera.layers.disable(BLOB_LAYER);
    assign(scene, albedoMaterials);
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(albedo);
    renderer.render(scene, camera);

    camera.layers.enable(BLOB_LAYER);
    assign(scene, lightMaterials);
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(light);
    renderer.render(scene, camera);

    shader.uniforms.albedo.value = albedo.texture;
    shader.uniforms.light.value = light.texture;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCamera);
  };
};
