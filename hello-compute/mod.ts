import { createBufferInit } from "../utils.ts";

// Get some numbers from the command line, or use the default 1, 4, 3, 295.
let numbers: Uint32Array;
if (Deno.args.length > 0) {
  numbers = new Uint32Array(Deno.args.map(parseInt));
} else {
  numbers = new Uint32Array([1, 4, 3, 295]);
}

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const shaderCode = `
[[builtin(global_invocation_id)]]
var global_id: vec3<u32>;

[[block]]
struct PrimeIndices {
    data: [[stride(4)]] array<u32>;
}; // this is used as both input and output for convenience

[[group(0), binding(0)]]
var<storage> v_indices: [[access(read_write)]] PrimeIndices;

// The Collatz Conjecture states that for any integer n:
// If n is even, n = n/2
// If n is odd, n = 3n+1
// And repeat this process for each new n, you will always eventually reach 1.
// Though the conjecture has not been proven, no counterexample has ever been found.
// This function returns how many times this recurrence needs to be applied to reach 1.
fn collatz_iterations(n_base: u32) -> u32{
    var n: u32 = n_base;
    var i: u32 = 0u;
    loop {
        if (n <= 1u) {
            break;
        }
        if (n % 2u == 0u) {
            n = n / 2u;
        }
        else {
            n = 3u * n + 1u;
        }
        i = i + 1u;
    }
    return i;
}

[[stage(compute), workgroup_size(1)]]
fn main() {
    v_indices.data[global_id.x] = collatz_iterations(v_indices.data[global_id.x]);
}
`;

const shaderModule = device.createShaderModule({
  code: shaderCode,
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
