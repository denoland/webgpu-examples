import { createBufferInit } from "../utils.ts";

const numbers = new Uint32Array([1, 4, 3, 295]);

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const shaderModule = device.createShaderModule({
  code: await Deno.readTextFile("./shader.wgsl"),
});

const stagingBuffer = device.createBuffer({
  size: numbers.byteLength,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});

const storageBuffer = createBufferInit(device, {
  label: "Storage Buffer",
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST |
    GPUBufferUsage.COPY_SRC,
  contents: numbers.buffer,
});

const bindGroupLayout = device.createBindGroupLayout({
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {
        type: "storage",
        minBindingSize: 4,
      },
    },
  ],
});

const bindGroup = device.createBindGroup({
  layout: bindGroupLayout,
  entries: [
    {
      binding: 0,
      resource: {
        buffer: storageBuffer,
      },
    },
  ],
});

const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [bindGroupLayout],
});

const computePipeline = device.createComputePipeline({
  layout: pipelineLayout,
  compute: {
    module: shaderModule,
    entryPoint: "main",
  },
});

const encoder = device.createCommandEncoder();

const computePass = encoder.beginComputePass();
computePass.setPipeline(computePipeline);
computePass.setBindGroup(0, bindGroup);
computePass.insertDebugMarker("compute collatz iterations");
computePass.dispatch(numbers.length);
computePass.endPass();

encoder.copyBufferToBuffer(
  storageBuffer,
  0,
  stagingBuffer,
  0,
  numbers.byteLength,
);

device.queue.submit([encoder.finish()]);

await stagingBuffer.mapAsync(1);
const data = stagingBuffer.getMappedRange();
console.log(new Uint32Array(data));
stagingBuffer.unmap();
