import {
  copyToBuffer,
  createBufferInit,
  createCapture,
  createPng,
} from "../utils.js";

async function init(device, dimensions, particles, particlesPerGroup) {
  const format = "rgba8unorm-srgb";

  const computeShader = device.createShaderModule({
    code: await Deno.readTextFile("./compute.wgsl"),
  });

  const drawShader = device.createShaderModule({
    code: await Deno.readTextFile("./draw.wgsl"),
  });

  const simParamData = new Float32Array([
    0.04, // deltaT
    0.1, // rule1Distance
    0.025, // rule2Distance
    0.025, // rule3Distance
    0.02, // rule1Scale
    0.05, // rule2Scale
    0.005, // rule3Scale
  ]);

  const unpaddedSize = simParamData.byteLength;
  const padding = 4 - unpaddedSize % 4;
  const paddedSize = padding + unpaddedSize;

  const simParamBuffer = device.createBuffer({
    label: "Simulation Parameter Buffer",
    usage: 0x0040 | 0x0008,
    mappedAtCreation: true,
    size: paddedSize,
  });
  const data = new Float32Array(simParamBuffer.getMappedRange());
  data.set(simParamData);
  simParamBuffer.unmap();

  const computeBindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: 0x4,
        buffer: {
          minBindingSize: simParamData.length * 4,
        },
      },
      {
        binding: 1,
        visibility: 0x4,
        buffer: {
          type: "read-only-storage",
          minBindingSize: particles * 16,
        },
      },
      {
        binding: 2,
        visibility: 0x4,
        buffer: {
          type: "storage",
          minBindingSize: particles * 16,
        },
      },
    ],
  });
  const computePipelineLayout = device.createPipelineLayout({
    label: "compute",
    bindGroupLayouts: [computeBindGroupLayout],
  });
  const renderPipelineLayout = device.createPipelineLayout({
    label: "render",
    bindGroupLayouts: [],
  });
  const renderPipeline = device.createRenderPipeline({
    layout: renderPipelineLayout,
    vertex: {
      module: drawShader,
      entryPoint: "main",
      buffers: [
        {
          arrayStride: 4 * 4,
          stepMode: "instance",
          attributes: [
            {
              format: "float2",
              offset: 0,
              shaderLocation: 0,
            },
            {
              format: "float2",
              offset: 8,
              shaderLocation: 1,
            },
          ],
        },
        {
          arrayStride: 2 * 4,
          attributes: [
            {
              format: "float2",
              offset: 0,
              shaderLocation: 2,
            },
          ],
        },
      ],
    },
    fragment: {
      module: drawShader,
      entryPoint: "main",
      targets: [
        {
          format,
        },
      ],
    },
  });
  const computePipeline = device.createComputePipeline({
    label: "Compute pipeline",
    layout: computePipelineLayout,
    compute: {
      module: computeShader,
      entryPoint: "main",
    },
  });
  const vertexBufferData = new Float32Array([
    -0.01,
    -0.02,
    0.01,
    -0.02,
    0.00,
    0.02,
  ]);
  const verticesBuffer = createBufferInit(device, {
    label: "Vertex Buffer",
    usage: 0x0020 | 0x0008,
    contents: vertexBufferData.buffer,
  });

  const initialParticleData = new Float32Array(4 * particles);
  for (let i = 0; i < initialParticleData.length; i += 4) {
    initialParticleData[i] = 2.0 * (Math.random() - 0.5); // posx
    initialParticleData[i + 1] = 2.0 * (Math.random() - 0.5); // posy
    initialParticleData[i + 2] = 2.0 * (Math.random() - 0.5) * 0.1; // velx
    initialParticleData[i + 3] = 2.0 * (Math.random() - 0.5) * 0.1;
  }

  const particleBuffers = [];
  const particleBindGroups = [];

  for (let i = 0; i < 2; i++) {
    particleBuffers.push(createBufferInit(device, {
      label: "Particle Buffer " + i,
      usage: 0x0020 | 0x0080 | 0x0008,
      contents: initialParticleData.buffer,
    }));
  }

  for (let i = 0; i < 2; i++) {
    particleBindGroups.push(device.createBindGroup({
      layout: computeBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: simParamBuffer,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: particleBuffers[i],
          },
        },
        {
          binding: 2,
          resource: {
            buffer: particleBuffers[(i + 1) % 2],
          },
        },
      ],
    }));
  }

  await render(
    device,
    dimensions,
    computePipeline,
    particleBindGroups,
    Math.ceil(particles / particlesPerGroup),
    renderPipeline,
    particleBuffers,
    verticesBuffer,
    particles,
  );
}

let frameNum = 0;
async function render(
  device,
  dimensions,
  computePipeline,
  particleBindGroups,
  workGroupCount,
  renderPipeline,
  particleBuffers,
  verticesBuffer,
  particles,
) {
  const { texture, outputBuffer } = createCapture(device, dimensions);

  const encoder = device.createCommandEncoder();
  encoder.pushDebugGroup("compute boid movement");
  const computePass = encoder.beginComputePass();
  computePass.setPipeline(computePipeline);
  computePass.setBindGroup(0, particleBindGroups[frameNum % 2]);
  computePass.dispatch(workGroupCount);
  computePass.endPass();
  encoder.popDebugGroup();

  encoder.pushDebugGroup("render boids");
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: texture.createView(),
        storeOp: "store",
        loadValue: [0, 0, 0, 1],
      },
    ],
  });
  renderPass.setPipeline(renderPipeline);
  renderPass.setVertexBuffer(0, particleBuffers[(frameNum + 1) % 2]);
  renderPass.setVertexBuffer(1, verticesBuffer);
  renderPass.draw(3, particles);
  renderPass.endPass();
  encoder.popDebugGroup();

  frameNum += 1;

  copyToBuffer(encoder, texture, outputBuffer, dimensions);

  device.queue.submit([encoder.finish()]);

  await createPng("./boids.png", outputBuffer, dimensions);
}

const dimensions = {
  height: 1200,
  width: 1600,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice();

await init(device, dimensions, 1500, 64);
