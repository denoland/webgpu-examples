import { gmath } from "../deps.ts";
import {
  copyToBuffer,
  createBufferInit,
  createCapture,
  createImage,
  Dimensions,
  OPENGL_TO_WGPU_MATRIX,
} from "../utils.ts";

function vertex(
  pos: [number, number, number],
  nor: [number, number, number],
): number[] {
  // deno-fmt-ignore
  return [
    ...pos, 1,
    ...nor, 0,
  ];
}

interface ObjectData {
  vertexData: Int8Array;
  indexData: Uint16Array;
}

function createCube(): ObjectData {
  const vertexData = new Int8Array([
    // top (0, 0, 1)
    ...vertex([-1, -1, 1], [0, 0, 1]),
    ...vertex([1, -1, 1], [0, 0, 1]),
    ...vertex([1, 1, 1], [0, 0, 1]),
    ...vertex([-1, 1, 1], [0, 0, 1]),
    // bottom (0, 0, -1)
    ...vertex([-1, 1, -1], [0, 0, -1]),
    ...vertex([1, 1, -1], [0, 0, -1]),
    ...vertex([1, -1, -1], [0, 0, -1]),
    ...vertex([-1, -1, -1], [0, 0, -1]),
    // right (1, 0, 0)
    ...vertex([1, -1, -1], [1, 0, 0]),
    ...vertex([1, 1, -1], [1, 0, 0]),
    ...vertex([1, 1, 1], [1, 0, 0]),
    ...vertex([1, -1, 1], [1, 0, 0]),
    // left (-1, 0, 0)
    ...vertex([-1, -1, 1], [-1, 0, 0]),
    ...vertex([-1, 1, 1], [-1, 0, 0]),
    ...vertex([-1, 1, -1], [-1, 0, 0]),
    ...vertex([-1, -1, -1], [-1, 0, 0]),
    // front (0, 1, 0)
    ...vertex([1, 1, -1], [0, 1, 0]),
    ...vertex([-1, 1, -1], [0, 1, 0]),
    ...vertex([-1, 1, 1], [0, 1, 0]),
    ...vertex([1, 1, 1], [0, 1, 0]),
    // back (0, -1, 0)
    ...vertex([1, -1, 1], [0, -1, 0]),
    ...vertex([-1, -1, 1], [0, -1, 0]),
    ...vertex([-1, -1, -1], [0, -1, 0]),
    ...vertex([1, -1, -1], [0, -1, 0]),
  ]);

  // deno-fmt-ignore
  const indexData = new Uint16Array([
    0, 1, 2, 2, 3, 0, // top
    4, 5, 6, 6, 7, 4, // bottom
    8, 9, 10, 10, 11, 8, // right
    12, 13, 14, 14, 15, 12, // left
    16, 17, 18, 18, 19, 16, // front
    20, 21, 22, 22, 23, 20, // back
  ]);

  return { vertexData, indexData };
}

function createPlane(size: number): ObjectData {
  let vertexData = new Int8Array([
    ...vertex([size, -size, 0], [0, 0, 1]),
    ...vertex([size, size, 0], [0, 0, 1]),
    ...vertex([-size, -size, 0], [0, 0, 1]),
    ...vertex([-size, size, 0], [0, 0, 1]),
  ]);

  let indexData = new Uint16Array([0, 1, 2, 2, 1, 3]);

  return { vertexData, indexData };
}

function generateMatrix(aspectRatio: number): Float32Array {
  const mxProjection = new gmath.PerspectiveFov(
    new gmath.Deg(45),
    aspectRatio,
    1,
    20,
  ).toPerspective().toMatrix4();
  const mxView = gmath.Matrix4.lookAtRh(
    new gmath.Vector3(3, -10, 6),
    new gmath.Vector3(0, 0, 0),
    gmath.Vector3.forward,
  );
  return OPENGL_TO_WGPU_MATRIX.mul(mxProjection.mul(mxView)).toFloat32Array();
}

interface Entity {
  mxWorld: gmath.Matrix4;
  rotationSpeed: number;
  color: [number, number, number, number];
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  indexCount: number;
  uniformOffset: number;
}

interface Light {
  pos: gmath.Vector3,
  color: [number, number, number, number],
  fov: number,
  depth: [number, number],
  targetView: GPUTextureView,
}

function lightToRaw(light: Light): Float32Array {
  let mxView = gmath.Matrix4.lookAtRh(light.pos, gmath.Vector3.zero, gmath.Vector3.forward);
  const projection = new gmath.PerspectiveFov(new gmath.Deg(light.fov), 1, light.depth[0], light.depth[1]);
  const mxViewProj = OPENGL_TO_WGPU_MATRIX.mul(projection.toPerspective().toMatrix4().mul(mxView));
  // deno-fmt-ignore
  return new Float32Array([
    ...mxViewProj.toFloat32Array().slice(),
    ...light.pos.toArray(), 1,
    ...light.color,
  ]);
}

let lightsAreDirty = true;
async function render(device: GPUDevice, dimensions: Dimensions, entities: Entity[], entityUniformBuffer: GPUBuffer, lights: Light[], lightStorageBuffer: GPUBuffer, lightSize: number, shadowPass: Pass, entityBindGroup: GPUBindGroup, forwardDepth: GPUTextureView, forwardPass: Pass) {
  for (const entity of entities) {
    if (entity.rotationSpeed != 0) {
      const rotation = gmath.Matrix4.fromAngleX(new gmath.Deg(entity.rotationSpeed));
      entity.mxWorld = entity.mxWorld.mul(rotation);
    }
    const data = new Float32Array([
      ...entity.mxWorld.toFloat32Array().slice(),
      ...entity.color,
    ]);
    device.queue.writeBuffer(entityUniformBuffer, entity.uniformOffset, data);
  }

  if (lightsAreDirty) {
    lightsAreDirty = false;
    for (let i = 0; i < lights.length; i++) {
      device.queue.writeBuffer(
        lightStorageBuffer,
        (i * lightSize),
        lightToRaw(lights[i]),
      );
    }
  }

  const encoder = device.createCommandEncoder();
  encoder.pushDebugGroup("shadow passes");
  for (let i = 0; i < lights.length; i++) {
    encoder.pushDebugGroup(`shadow pass ${i} (light at position ${lights[i].pos})`);

    encoder.copyBufferToBuffer(
      lightStorageBuffer,
      i * lightSize,
      shadowPass.uniformBuffer,
      0,
      64,
    );

    encoder.insertDebugMarker("render entities");

    const renderPass = encoder.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: lights[i].targetView,
        depthLoadValue: 1,
        depthStoreOp: "store",
        stencilLoadValue: "load",
        stencilStoreOp: "store",
      },
    });
    renderPass.setPipeline(shadowPass.pipeline);
    renderPass.setBindGroup(0, shadowPass.bindGroup);

    for (const entity of entities) {
      renderPass.setBindGroup(1, entityBindGroup, [entity.uniformOffset]);
      renderPass.setIndexBuffer(entity.indexBuffer, entity.indexFormat);
      renderPass.setVertexBuffer(0, entity.vertexBuffer);
      renderPass.drawIndexed(entity.indexCount, 1);
    }
    renderPass.endPass();
    encoder.popDebugGroup();
  }
  encoder.popDebugGroup();
  const { texture, outputBuffer } = createCapture(device, dimensions);

  encoder.pushDebugGroup("forward rendering pass");
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        loadValue: [0.1, 0.2, 0,3, 1],
        storeOp: "store",
      },
    ],
    depthStencilAttachment: {
      view: forwardDepth,
      depthLoadValue: 1,
      depthStoreOp: "clear",
      stencilLoadValue: "load",
      stencilStoreOp: "store",
    }
  });
  renderPass.setPipeline(forwardPass.pipeline);
  renderPass.setBindGroup(0, forwardPass.bindGroup);
  for (const entity of entities) {
    renderPass.setBindGroup(1, entityBindGroup, [entity.uniformOffset]);
    renderPass.setIndexBuffer(entity.indexBuffer, entity.indexFormat);
    renderPass.setVertexBuffer(0, entity.vertexBuffer);
    renderPass.drawIndexed(entity.indexCount, 1);
  }
  renderPass.endPass();
  encoder.popDebugGroup();

  copyToBuffer(encoder, texture, outputBuffer, dimensions);

  device.queue.submit([encoder.finish()]);

  await createImage(outputBuffer, dimensions);
}

const dimensions: Dimensions = {
  width: 800,
  height: 600,
};
const maxLights = 10;
const shadowSize: GPUExtent3D = {
  width: 512,
  height: 512,
  depth: maxLights,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice({
  nonGuaranteedFeatures: ["depth-clamping"],
});

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const vertexSize = 1 * 4 * 2;
const { vertexData: cubeVertexData, indexData: cubeIndexData } = createCube();
const cubeVertexBuffer = createBufferInit(device, {
  label: "Cubes Vertex Buffer",
  usage: 0x20,
  contents: cubeVertexData.buffer,
});
const cubeIndexBuffer = createBufferInit(device, {
  label: "Cubes Index Buffer",
  usage: 0x10,
  contents: cubeIndexData.buffer,
});

const { vertexData: planeVertexData, indexData: planeIndexData } = createPlane(
  7,
);
const planeVertexBuffer = createBufferInit(device, {
  label: "Plane Vertex Buffer",
  usage: 0x20,
  contents: planeVertexData.buffer,
});
const planeIndexBuffer = createBufferInit(device, {
  label: "Plane Index Buffer",
  usage: 0x10,
  contents: planeIndexData.buffer,
});

interface CubeDesc {
  offset: gmath.Vector3;
  angle: number;
  scale: number;
  rotation: number;
}

const cubeDescs: CubeDesc[] = [
  {
    offset: new gmath.Vector3(-2.0, -2.0, 2.0),
    angle: 10.0,
    scale: 0.7,
    rotation: 0.1,
  },
  {
    offset: new gmath.Vector3(2.0, -2.0, 2.0),
    angle: 50.0,
    scale: 1.3,
    rotation: 0.2,
  },
  {
    offset: new gmath.Vector3(-2.0, 2.0, 2.0),
    angle: 140.0,
    scale: 1.1,
    rotation: 0.3,
  },
  {
    offset: new gmath.Vector3(2.0, 2.0, 2.0),
    angle: 210.0,
    scale: 0.9,
    rotation: 0.4,
  },
];

const entityUniformSize = (4 * 4 * 4) + (4 * 4);
const numEntities = 1 + cubeDescs.length;
const entityUniformBuffer = device.createBuffer({
  size: numEntities * 256,
  usage: 0x40 | 8,
});

const entities: Entity[] = [
  {
    mxWorld: gmath.Matrix4.fromCols(
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ),
    rotationSpeed: 0,
    color: [1, 1, 1, 1],
    vertexBuffer: planeVertexBuffer,
    indexBuffer: planeIndexBuffer,
    indexFormat: "uint16",
    indexCount: planeIndexData.length,
    uniformOffset: 0,
  },
];

// TODO
const x = [
  gmath.Matrix4.fromCols(
    0.6929103, 0.07372393, 0.06663421, 0.0,
    -0.06663421, 0.6929103, -0.07372393, 0.0,
    -0.07372393, 0.06663421, 0.6929103, 0.0,
    -2.0, -2.0, 2.0, 1.0,
  ),
  gmath.Matrix4.fromCols(
    0.990416, 0.42016667, 0.72975075, 0.0,
    -0.72975075, 0.990416, 0.42016667, 0.0,
    -0.42016667, -0.72975075, 0.990416, 0.0,
    2.0, -2.0, 2.0, 1.0,
  ),
  gmath.Matrix4.fromCols(
    -0.19509922, -0.23932466, -1.0557746, 0.0,
    -1.0557746, -0.19509922, 0.23932466, 0.0,
    -0.23932466, 1.0557746, -0.19509922, 0.0,
    -2.0, 2.0, 2.0, 1.0,
  ),
  gmath.Matrix4.fromCols(
    -0.21961509, 0.29999992, 0.8196151, 0.0,
    0.8196151, -0.21961509, 0.29999992, 0.0,
    0.29999992, 0.8196151, -0.21961509, 0.0,
    2.0, 2.0, 2.0, 1.0,
  ),
];

for (let i = 0; i < cubeDescs.length; i++) {
  entities.push({
    mxWorld: x[i],
    rotationSpeed: cubeDescs[i].rotation,
    color: [0, 1, 0, 1],
    vertexBuffer: cubeVertexBuffer,
    indexBuffer: cubeIndexBuffer,
    indexFormat: "uint16",
    indexCount: cubeIndexData.length,
    uniformOffset: (i + 1) * 256,
  });
}

const localBindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: 1 | 2,
      buffer: {
        hasDynamicOffset: true,
        minBindingSize: entityUniformSize,
      },
    },
  ],
});
const entityBindGroup = device.createBindGroup({
  layout: localBindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: entityUniformBuffer,
        size: entityUniformSize,
      },
    },
  ],
});

const shadowSampler = device.createSampler({
  label: "shadow",
  magFilter: "linear",
  minFilter: "linear",
  compare: "less-equal",
});
const shadowTexture = device.createTexture({
  size: shadowSize,
  format: "depth32float",
  usage: 0x10 | 4,
});
const shadowView = shadowTexture.createView();
const shadowTargetViews: GPUTextureView[] = [0, 1].map((i) => {
  return shadowTexture.createView({
    label: "shadow",
    dimension: "2d",
    baseArrayLayer: i,
    arrayLayerCount: 1,
  });
});

const lights: Light[] = [
  {
    pos: new gmath.Vector3(7.0, -5.0, 10.0),
    color: [0.5, 1, 0.5, 1],
    fov: 60,
    depth: [1, 20],
    targetView: shadowTargetViews[0],
  },
  {
    pos: new gmath.Vector3(-5.0, 7.0, 10.0),
    color: [1, 0.5, 0.5, 1],
    fov: 45,
    depth: [1, 20],
    targetView: shadowTargetViews[1],
  },
];

const lightSize = (4 * 4 * 4) + (4 * 4) + (4 * 4);
const lightUniformSize = maxLights * lightSize;
const lightStorageBuffer = device.createBuffer({
  size: lightUniformSize,
  usage: 0x80 | 4 | 8,
});

const vertexBufferLayout: GPUVertexBufferLayout = {
  arrayStride: vertexSize,
  attributes: [
    {
      format: "char4",
      offset: 0,
      shaderLocation: 0,
    },
    {
      format: "char4",
      offset: 4,
      shaderLocation: 1,
    },
  ],
};

const shader = device.createShaderModule({
  code: await Deno.readTextFile("./shader.wgsl"),
});

interface Pass {
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup;
  uniformBuffer: GPUBuffer;
}

const uniformSize = (4 * 4 * 4) + (4 * 4);
const shadowBindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: 1,
      buffer: {
        minBindingSize: uniformSize,
      }
    }
  ]
});
const shadowPipelineLayout = device.createPipelineLayout({
  label: "shadow",
  bindGroupLayouts: [shadowBindGroupLayout, localBindGroupLayout],
});
const shadowUniformBuffer = device.createBuffer({
  size: uniformSize,
  usage: 0x40 | 8,
});

const shadowBindGroup = device.createBindGroup({
  layout: shadowBindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: shadowUniformBuffer,
      },
    },
  ],
});

const shadowRenderPipeline = device.createRenderPipeline({
  label: "shadow",
  layout: shadowPipelineLayout,
  vertex: {
    module: shader,
    entryPoint: "vs_bake",
    buffers: [vertexBufferLayout],
  },
  primitive: {
    cullMode: "back",
  },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "less-equal",
    depthBias: 2,
    depthBiasSlopeScale: 2,
    clampDepth: device.features.includes("depth-clamping"),
  },
});

const shadowPass: Pass = {
  pipeline: shadowRenderPipeline,
  bindGroup: shadowBindGroup,
  uniformBuffer: shadowUniformBuffer,
}

const forwardBindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: 1 | 2,
      buffer: {
        minBindingSize: uniformSize,
      },
    },
    {
      binding: 1,
      visibility: 1 | 2,
      buffer: {
        type: "read-only-storage",
        minBindingSize: lightUniformSize,
      },
    },
    {
      binding: 2,
      visibility: 2,
      texture: {
        sampleType: "depth",
        viewDimension: "2d-array",
      },
    },
    {
      binding: 3,
      visibility: 2,
      sampler: {
        type: "comparison",
      },
    },
  ],
});
const forwardPipelineLayout = device.createPipelineLayout({
  label: "main",
  bindGroupLayouts: [forwardBindGroupLayout, localBindGroupLayout],
});


const mxTotal = generateMatrix(dimensions.width / dimensions.height);
const buffer = new ArrayBuffer(mxTotal.byteLength + (4 * 4));
const float32 = new Float32Array(buffer);
float32.set(mxTotal);
const uint32 = new Uint32Array(buffer);
uint32.set([lights.length, 0, 0, 0], uint32.length - 4);

const forwardUniformBuffer = createBufferInit(device, {
  label: "Uniform Buffer",
  usage: 0x40 | 8,
  contents: buffer,
});

const forwardBindGroup = device.createBindGroup({
  layout: forwardBindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: forwardUniformBuffer,
      }
    },
    {
      binding: 1,
      resource: {
        buffer: lightStorageBuffer,
      }
    },
    {
      binding: 2,
      resource: shadowView,
    },
    {
      binding: 3,
      resource: shadowSampler,
    },
  ],
});

const forwardRenderPipeline = device.createRenderPipeline({
  label: "main",
  layout: forwardPipelineLayout,
  vertex: {
    module: shader,
    entryPoint: "vs_main",
    buffers: [vertexBufferLayout]
  },
  fragment: {
    module: shader,
    entryPoint: "fs_main",
    targets: [
      {
        format: "rgba8unorm-srgb",
      },
    ],
  },
  primitive: {
    cullMode: "back",
  },
  depthStencil: {
    format: "depth32float",
    depthWriteEnabled: true,
    depthCompare: "less",
  },
});

const forwardPass: Pass = {
  pipeline: forwardRenderPipeline,
  bindGroup: forwardBindGroup,
  uniformBuffer: forwardUniformBuffer,
}

const depthTexture = device.createTexture({
  size: dimensions,
  format: "depth32float",
  usage: 0x10,
});

await render(device, dimensions, entities, entityUniformBuffer, lights, lightStorageBuffer, lightSize, shadowPass, entityBindGroup, depthTexture.createView(), forwardPass);
