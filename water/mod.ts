import { gmath, makeNoise2D } from "../deps.ts";
import { Framework } from "../framework.ts";
import {
  createBufferInit,
  Dimensions,
  OPENGL_TO_WGPU_MATRIX,
} from "../utils.ts";
import {
  HexTerrainMesh,
  HexWaterMesh,
  TERRAIN_VERTEX_ATTRIBUTES_SIZE,
  WATER_VERTEX_ATTRIBUTES_SIZE,
} from "./point_gen.ts";

const SIZE = 29;
const CAMERA = new gmath.Vector3(-200.0, 70.0, 200.0);

interface Matrices {
  view: gmath.Matrix4;
  flippedView: gmath.Matrix4;
  projection: gmath.Matrix4;
}

function generateMatrices(aspectRatio: number): Matrices {
  const projection = new gmath.PerspectiveFov(
    new gmath.Deg(45),
    aspectRatio,
    10,
    400,
  ).toMatrix4();
  const regView = gmath.Matrix4.lookAtRh(
    CAMERA,
    gmath.Vector3.zero(),
    gmath.Vector3.up(),
  );
  const scale = gmath.Matrix4.from(
    8, 0, 0, 0,
    0, 1.5, 0, 0,
    0, 0, 8, 0,
    0, 0, 0, 1,
  );

  const flippedView = gmath.Matrix4.lookAtRh(
    new gmath.Vector3(CAMERA.x, -CAMERA.y, CAMERA.z),
    gmath.Vector3.zero(),
    gmath.Vector3.up(),
  );

  return {
    view: regView.mul(scale),
    flippedView,
    projection: OPENGL_TO_WGPU_MATRIX.mul(projection),
  };
}

interface Uniforms {
  terrainNormal: Uint8Array;
  terrainFlipped: Uint8Array;
  water: Uint8Array;
}

const TERRAIN_SIZE = 20 * 4;
const WATER_SIZE = 40 * 4;

function generateUniforms(width: number, height: number): Uniforms {
  const { view, flippedView, projection } = generateMatrices(width / height);

  const terrainNormal = new Float32Array(TERRAIN_SIZE / 4);
  terrainNormal.set(projection.mul(view).toFloat32Array());
  terrainNormal.set([0, 0, 0, 0], 16);

  const terrainFlipped = new Float32Array(TERRAIN_SIZE / 4);
  terrainFlipped.set(projection.mul(flippedView).toFloat32Array());
  terrainFlipped.set([0, 1, 0, 0], 16);

  const water = new Float32Array(WATER_SIZE / 4);
  water.set(view.toFloat32Array());
  water.set(projection.toFloat32Array(), 16);
  water.set([0.0, 1.0, SIZE * 2.0, width], 32);
  water.set([height, 0.0, 0.0, 0.0], 36);

  return {
    terrainNormal: new Uint8Array(terrainNormal.buffer),
    terrainFlipped: new Uint8Array(terrainFlipped.buffer),
    water: new Uint8Array(water.buffer),
  };
}

function initializeResources(
  dimensions: Dimensions,
  device: GPUDevice,
  waterUniforms: GPUBuffer,
  terrainNormalUniforms: GPUBuffer,
  terrainFlippedUniforms: GPUBuffer,
  waterBindGroupLayout: GPUBindGroupLayout,
): [GPUTextureView, GPUTextureView, GPUBindGroup] {
  const {
    terrainNormal,
    terrainFlipped,
    water,
  } = generateUniforms(dimensions.width, dimensions.height);

  device.queue.writeBuffer(terrainNormalUniforms, 0, terrainNormal);
  device.queue.writeBuffer(terrainFlippedUniforms, 0, terrainFlipped);
  device.queue.writeBuffer(waterUniforms, 0, water);

  const reflectionTexture = device.createTexture({
    label: "Reflection Render Texture",
    size: dimensions,
    format: "rgba8unorm-srgb",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const drawDepthBuffer = device.createTexture({
    label: "Depth Buffer",
    size: dimensions,
    format: "depth32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const sampler = device.createSampler({
    label: "Texture Sampler",
    minFilter: "linear",
  });

  const depthView = drawDepthBuffer.createView();

  const waterBindGroup = device.createBindGroup({
    label: "Water Bind Group",
    layout: waterBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          buffer: waterUniforms,
        },
      },
      {
        binding: 1,
        resource: reflectionTexture.createView(),
      },
      {
        binding: 2,
        resource: depthView,
      },
      {
        binding: 3,
        resource: sampler,
      },
    ],
  });

  return [reflectionTexture.createView(), depthView, waterBindGroup];
}

class Water extends Framework {
  waterVertexBuf!: GPUBuffer;
  waterVertexCount!: number;
  waterBindGroupLayout!: GPUBindGroupLayout;
  waterBindGroup!: GPUBindGroup;
  waterUniformBuf!: GPUBuffer;
  waterPipeline!: GPURenderPipeline;

  terrainVertexBuf!: GPUBuffer;
  terrainVertexCount!: number;
  terrainNormalBindGroup!: GPUBindGroup;

  terrainFlippedBindGroup!: GPUBindGroup;
  terrainNormalUniformBuf!: GPUBuffer;

  terrainFlippedUniformBuf!: GPUBuffer;
  terrainPipeline!: GPURenderPipeline;

  reflectView!: GPUTextureView;
  depthBuffer!: GPUTextureView;

  async init(): Promise<void> {
    const waterVertices = new HexWaterMesh(SIZE).generatePoints();
    this.waterVertexCount = waterVertices.length;
    const waterVerticesBuf = new Int8Array(
      waterVertices.map((buf) => [...buf]).flat(),
    );

    const terrainNoise = makeNoise2D(0);
    const terrain = new HexTerrainMesh(SIZE, (point) => {
      const noise = terrainNoise(point[0] / 5, point[1] / 5) + 0.1;
      const y = noise * 22;
      function mulArr(
        arr: [number, number, number, number],
        by: number,
      ): [number, number, number, number] {
        arr[0] = Math.min(arr[0] * by, 255);
        arr[1] = Math.min(arr[1] * by, 255);
        arr[2] = Math.min(arr[2] * by, 255);
        return arr;
      }

      const DARK_SAND = [235, 175, 71, 255];
      const SAND = [217, 191, 76, 255];
      const GRASS = [122, 170, 19, 255];
      const SNOW = [175, 224, 237, 255];

      const random = Math.random() * 0.2 + 0.9;

      let color: number[];
      if (y <= 0.0) {
        color = DARK_SAND;
      } else if (y <= 0.8) {
        color = SAND;
      } else if (y <= 10.0) {
        color = GRASS;
      } else {
        color = SNOW;
      }

      return {
        position: new gmath.Vector3(point[0], y, point[1]),
        color: mulArr(color as [number, number, number, number], random),
      };
    });
    const terrainVertices = terrain.makeBufferData();
    this.terrainVertexCount = waterVertices.length;
    const terrainVerticesBuf = new Uint8Array(
      terrainVertices.map((buf) => [...buf]).flat(),
    );

    this.waterVertexBuf = createBufferInit(this.device, {
      label: "Water vertices",
      contents: waterVerticesBuf.buffer,
      usage: GPUBufferUsage.VERTEX,
    });
    this.terrainVertexBuf = createBufferInit(this.device, {
      label: "Terrain vertices",
      contents: terrainVerticesBuf.buffer,
      usage: GPUBufferUsage.VERTEX,
    });

    this.waterBindGroupLayout = this.device.createBindGroupLayout({
      label: "Water Bind Group Layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            minBindingSize: WATER_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {},
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: {},
        },
      ],
    });
    const terrainBindGroupLayout = this.device.createBindGroupLayout({
      label: "Terrain Bind Group Layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: {
            minBindingSize: TERRAIN_SIZE,
          },
        },
      ],
    });

    const waterPipelineLayout = this.device.createPipelineLayout({
      label: "water",
      bindGroupLayouts: [this.waterBindGroupLayout],
    });
    const terrainPipelineLayout = this.device.createPipelineLayout({
      label: "terrain",
      bindGroupLayouts: [terrainBindGroupLayout],
    });

    this.waterUniformBuf = this.device.createBuffer({
      label: "Water Uniforms",
      size: WATER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.terrainNormalUniformBuf = this.device.createBuffer({
      label: "Normal Terrain Uniforms",
      size: TERRAIN_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.terrainFlippedUniformBuf = this.device.createBuffer({
      label: "Flipped Terrain Uniforms",
      size: TERRAIN_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const [reflectView, depthBuffer, waterBindGroup] = initializeResources(
      this.dimensions,
      this.device,
      this.waterUniformBuf,
      this.terrainNormalUniformBuf,
      this.terrainFlippedUniformBuf,
      this.waterBindGroupLayout,
    );
    this.reflectView = reflectView;
    this.depthBuffer = depthBuffer;
    this.waterBindGroup = waterBindGroup;

    this.terrainNormalBindGroup = this.device.createBindGroup({
      label: "Terrain Normal Bind Group",
      layout: terrainBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.terrainNormalUniformBuf,
          },
        },
      ],
    });
    this.terrainFlippedBindGroup = this.device.createBindGroup({
      label: "Terrain Flipped Bind Group",
      layout: terrainBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this.terrainFlippedUniformBuf,
          },
        },
      ],
    });

    const terrainModule = this.device.createShaderModule({
      label: "terrain",
      code: Deno.readTextFileSync(new URL("./terrain.wgsl", import.meta.url)),
    });
    const waterModule = this.device.createShaderModule({
      label: "water",
      code: Deno.readTextFileSync(new URL("./water.wgsl", import.meta.url)),
    });

    this.waterPipeline = this.device.createRenderPipeline({
      label: "water",
      layout: waterPipelineLayout,
      vertex: {
        module: waterModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: WATER_VERTEX_ATTRIBUTES_SIZE,
            attributes: [
              {
                format: "sint16x2",
                offset: 0,
                shaderLocation: 0,
              },
              {
                format: "sint8x4",
                offset: 4,
                shaderLocation: 1,
              },
            ],
          },
        ],
      },
      fragment: {
        module: waterModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: "rgba8unorm-srgb",
            blend: {
              // @ts-ignore 1.18.2
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              // @ts-ignore 1.18.2
              alpha: {
                operation: "max",
                dstFactor: "one",
              },
            },
          },
        ],
      },
      primitive: {
        frontFace: "cw",
      },
      depthStencil: {
        format: "depth32float",
        depthCompare: "less",
      },
    });
    this.terrainPipeline = this.device.createRenderPipeline({
      label: "terrain",
      layout: terrainPipelineLayout,
      vertex: {
        module: terrainModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: TERRAIN_VERTEX_ATTRIBUTES_SIZE,
            attributes: [
              {
                format: "float32x3",
                offset: 0,
                shaderLocation: 0,
              },
              {
                format: "float32x3",
                offset: 12,
                shaderLocation: 1,
              },
              {
                format: "unorm8x4",
                offset: 24,
                shaderLocation: 2,
              },
            ],
          },
        ],
      },
      fragment: {
        module: terrainModule,
        entryPoint: "fs_main",
        targets: [{
          format: "rgba8unorm-srgb",
        }],
      },
      primitive: {
        cullMode: "front",
      },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  render(encoder: GPUCommandEncoder, view: GPUTextureView) {
    const backColor = {
      r: 161.0 / 255.0,
      g: 246.0 / 255.0,
      b: 255.0 / 255.0,
      a: 1.0,
    };
    const waterSin = Math.sin(0);
    const waterCos = Math.cos(0);

    this.device.queue.writeBuffer(
      this.waterUniformBuf,
      128,
      new Float32Array([waterSin, waterCos]),
    );

    {
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.reflectView,
            loadValue: backColor,
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: this.depthBuffer,
          depthLoadValue: 1,
          depthStoreOp: "store",
          stencilLoadValue: "load",
          stencilStoreOp: "store",
        },
      });
      renderPass.setPipeline(this.terrainPipeline);
      renderPass.setBindGroup(0, this.terrainFlippedBindGroup);
      renderPass.setVertexBuffer(0, this.terrainVertexBuf);
      renderPass.draw(this.terrainVertexCount);
      renderPass.endPass();
    }

    {
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadValue: backColor,
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: this.depthBuffer,
          depthLoadValue: 1,
          depthStoreOp: "store",
          stencilLoadValue: "load",
          stencilStoreOp: "store",
        },
      });
      renderPass.setPipeline(this.terrainPipeline);
      renderPass.setBindGroup(0, this.terrainNormalBindGroup);
      renderPass.setVertexBuffer(0, this.terrainVertexBuf);
      renderPass.draw(this.terrainVertexCount);
      renderPass.endPass();
    }

    {
      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadValue: "load",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: this.depthBuffer,
          depthLoadValue: "load",
          depthStoreOp: "store",
          stencilLoadValue: "load",
          stencilStoreOp: "store",
        },
      });
      renderPass.setPipeline(this.waterPipeline);
      renderPass.setBindGroup(0, this.waterBindGroup);
      renderPass.setVertexBuffer(0, this.waterVertexBuf);
      renderPass.draw(this.waterVertexCount);
      renderPass.endPass();
    }
  }
}

const water = new Water(
  {
    width: 1600,
    height: 1200,
  },
  await Water.getDevice(),
);
await water.renderPng();
