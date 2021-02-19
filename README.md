These examples are a deno port of the
[wgpu-rs examples](https://github.com/gfx-rs/wgpu-rs/tree/master/examples) but
using `utils`'s `createCapture`, `copyToBuffer` & `createPng` instead of a
swapchain as deno's webgpu implementation is headless.

To try out, compile https://github.com/denoland/deno/pull/7977 from source and
run the commands below.

```shell
$ cd hello-compute
$ deno run --unstable --allow-read --allow-write mod.ts
Uint32Array(4) [ 0, 2, 7, 55 ]
```
