import { gmath } from "../deps.ts";
import {
  copyToBuffer,
  createBufferInit,
  createCapture,
  createImage,
  Dimensions,
  OPENGL_TO_WGPU_MATRIX,
} from "../utils.ts";

function vertex(pos: [number, number, number], tc: [number, number]): number[] {
  return [...pos, 1, ...tc];
}

function createVertices(): {
  vertexData: Float32Array;
  indexData: Uint16Array;
} {
  const vertexData = new Float32Array([
    // top (0, 0, 1)
    ...vertex([-1, -1, 1], [0, 0]),
    ...vertex([1, -1, 1], [1, 0]),
    ...vertex([1, 1, 1], [1, 1]),
    ...vertex([-1, 1, 1], [0, 1]),
    // bottom (0, 0, -1)
    ...vertex([-1, 1, -1], [1, 0]),
    ...vertex([1, 1, -1], [0, 0]),
    ...vertex([1, -1, -1], [0, 1]),
    ...vertex([-1, -1, -1], [1, 1]),
    // right (1, 0, 0)
    ...vertex([1, -1, -1], [0, 0]),
    ...vertex([1, 1, -1], [1, 0]),
    ...vertex([1, 1, 1], [1, 1]),
    ...vertex([1, -1, 1], [0, 1]),
    // left (-1, 0, 0)
    ...vertex([-1, -1, 1], [1, 0]),
    ...vertex([-1, 1, 1], [0, 0]),
    ...vertex([-1, 1, -1], [0, 1]),
    ...vertex([-1, -1, -1], [1, 1]),
    // front (0, 1, 0)
    ...vertex([1, 1, -1], [1, 0]),
    ...vertex([-1, 1, -1], [0, 0]),
    ...vertex([-1, 1, 1], [0, 1]),
    ...vertex([1, 1, 1], [1, 1]),
    // back (0, -1, 0)
    ...vertex([1, -1, 1], [0, 0]),
    ...vertex([-1, -1, 1], [1, 0]),
    ...vertex([-1, -1, -1], [1, 1]),
    ...vertex([1, -1, -1], [0, 1]),
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

function createTexels(size: number): Uint8Array {
  const texels = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const cx = 3 * (i % size) / (size - 1) - 2;
    const cy = 2 * Math.floor(i / size) / (size - 1) - 1;
    let count = 0;
    let x = cx;
    let y = cy;
    while (count < 0xFF && x * x + y * y < 4) {
      const oldX = x;
      x = x * x - y * y + cx;
      y = 2.0 * oldX * y + cy;
      count += 1;
    }
    texels.set(
      [
        0xFF - ((count * 5) & ~(~0 << 8)),
        0xFF - ((count * 15) & ~(~0 << 8)),
        0xFF - ((count * 50) & ~(~0 << 8)),
        1,
      ],
      i * 4,
    );
  }
  return texels;
}

function generateMatrix(aspectRatio: number): Float32Array {
  const mxProjection = new gmath.PerspectiveFov(
    new gmath.Deg(45),
    aspectRatio,
    1,
    1000,
  ).toPerspective().toMatrix4();
  const mxView = gmath.Matrix4.lookAtRh(
    new gmath.Vector3(1.5, -5, 3),
    new gmath.Vector3(0, 0, 0),
    gmath.Vector3.forward,
  );
  return OPENGL_TO_WGPU_MATRIX.mul(mxProjection.mul(mxView)).toFloat32Array();
}

async function render(
  device: GPUDevice,
  dimensions: Dimensions,
  pipeline: GPURenderPipeline,
  bindGroup: GPUBindGroup,
  indexBuffer: GPUBuffer,
  vertexBuffer: GPUBuffer,
  indexCount: number,
) {
  const { texture, outputBuffer } = createCapture(device, dimensions);

  const encoder = device.createCommandEncoder();
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        storeOp: "store",
        loadValue: [0.1, 0.2, 0.3, 1],
      },
    ],
  });

  renderPass.pushDebugGroup("Prepare data for draw.");
  renderPass.setPipeline(pipeline);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.setIndexBuffer(indexBuffer, "uint16");
  renderPass.setVertexBuffer(0, vertexBuffer);
  renderPass.popDebugGroup();
  renderPass.insertDebugMarker("Draw!");
  renderPass.drawIndexed(indexCount, 1);
  renderPass.endPass();

  copyToBuffer(encoder, texture, outputBuffer, dimensions);

  device.queue.submit([encoder.finish()]);

  await createImage(outputBuffer, dimensions);
}

const dimensions: Dimensions = {
  width: 1600,
  height: 1200,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const { vertexData, indexData } = createVertices();

const vertexBuffer = createBufferInit(device, {
  label: "Vertex Buffer",
  usage: 0x20,
  contents: vertexData.buffer,
});

const indexBuffer = createBufferInit(device, {
  label: "Index Buffer",
  usage: 0x10,
  contents: indexData.buffer,
});

const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: 1,
      buffer: {
        minBindingSize: 64,
      },
    },
    {
      binding: 1,
      visibility: 2,
      texture: {},
    },
    {
      binding: 2,
      visibility: 2,
      sampler: {},
    },
  ],
});

const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [bindGroupLayout],
});

const size = 256;
const texels = createTexels(size);
const textureExtent = {
  width: size,
  height: size,
};

const texture = device.createTexture({
  size: textureExtent,
  format: "rgba8unorm-srgb",
  usage: 4 | 2,
});
const textureView = texture.createView();
device.queue.writeTexture(
  {
    texture,
  },
  texels,
  {
    bytesPerRow: 4 * size,
    rowsPerImage: 0,
  },
  textureExtent,
);

const sampler = device.createSampler({
  minFilter: "linear",
});

const mxTotal = generateMatrix(dimensions.width / dimensions.height);
const uniformBuffer = createBufferInit(device, {
  label: "Uniform Buffer",
  usage: 0x40 | 8,
  contents: mxTotal.buffer,
});

const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: uniformBuffer,
      },
    },
    {
      binding: 1,
      resource: textureView,
    },
    {
      binding: 2,
      resource: sampler,
    },
  ],
});

const shader = device.createShaderModule({
  code: await Deno.readTextFile("./shader.wgsl"),
});
const vertexBuffers: GPUVertexBufferLayout[] = [
  {
    arrayStride: 6 * 4,
    attributes: [
      {
        format: "float4",
        offset: 0,
        shaderLocation: 0,
      },
      {
        format: "float2",
        offset: 4 * 4,
        shaderLocation: 1,
      },
    ],
  },
];

const pipeline = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: {
    module: shader,
    entryPoint: "vs_main",
    buffers: vertexBuffers,
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
});

await render(
  device,
  dimensions,
  pipeline,
  bindGroup,
  indexBuffer,
  vertexBuffer,
  indexData.length,
);
