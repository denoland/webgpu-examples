import {
  copyToBuffer,
  createCapture,
  createPng,
  Dimensions,
} from "../utils.ts";

const dimensions: Dimensions = {
  width: 200,
  height: 200,
};

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter?.requestDevice();

if (!device) {
  console.error("no suitable adapter found");
  Deno.exit(0);
}

const shaderCode = `
[[builtin(vertex_index)]]
var<in> in_vertex_index: u32;
[[builtin(position)]]
var<out> out_pos: vec4<f32>;

[[stage(vertex)]]
fn vs_main() {
    var x: f32 = f32(i32(in_vertex_index) - 1);
    var y: f32 = f32(i32(in_vertex_index & 1) * 2 - 1);
    out_pos = vec4<f32>(x, y, 0.0, 1.0);
}

[[location(0)]]
var<out> out_color: vec4<f32>;

[[stage(fragment)]]
fn fs_main() {
    out_color = vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;

const shaderModule = device.createShaderModule({
  code: shaderCode,
});

const pipelineLayout = device.createPipelineLayout({
  bindGroupLayouts: [],
});

const renderPipeline = device.createRenderPipeline({
  layout: pipelineLayout,
  vertex: {
    module: shaderModule,
    entryPoint: "vs_main",
  },
  fragment: {
    module: shaderModule,
    entryPoint: "fs_main",
    targets: [
      {
        format: "rgba8unorm-srgb",
      },
    ],
  },
});

const { texture, outputBuffer } = createCapture(device, dimensions);

const encoder = device.createCommandEncoder();
const renderPass = encoder.beginRenderPass({
  colorAttachments: [
    {
      view: texture.createView(),
      storeOp: "store",
      loadValue: [0, 1, 0, 1],
    },
  ],
});
renderPass.setPipeline(renderPipeline);
renderPass.draw(3, 1);
renderPass.endPass();

copyToBuffer(encoder, texture, outputBuffer, dimensions);

device.queue.submit([encoder.finish()]);

await createPng(outputBuffer, dimensions);
