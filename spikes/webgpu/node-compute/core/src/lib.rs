use std::borrow::Cow;

use futures_channel::oneshot;
use serde::Serialize;
use wgpu::util::DeviceExt;

const X: [f32; 4] = [1.0, 2.0, 3.0, 4.0];
const Y: [f32; 4] = [10.0, 20.0, 30.0, 40.0];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaxpyResult {
    accelerated_path_engaged: bool,
    adapter_name: String,
    backend: String,
    device_type: String,
    values: Vec<f32>,
}

pub async fn compute_saxpy() -> Result<SaxpyResult, String> {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
    if std::env::var_os("WGPU_BACKEND").is_none() {
        descriptor.backends = wgpu::Backends::PRIMARY;
    }
    let backends = descriptor.backends;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = match std::env::var("WGPU_ADAPTER_NAME") {
        Ok(requested_name) => {
            let requested_name = requested_name.to_lowercase();
            instance
                .enumerate_adapters(backends)
                .await
                .into_iter()
                .find(|candidate| {
                    candidate
                        .get_info()
                        .name
                        .to_lowercase()
                        .contains(&requested_name)
                })
                .ok_or_else(|| {
                    format!(
                        "request_adapter: no {backends:?} adapter matched WGPU_ADAPTER_NAME={requested_name}"
                    )
                })?
        }
        Err(_) => instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                ..Default::default()
            })
            .await
            .map_err(|error| format!("request_adapter: {error}"))?,
    };
    let info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("picovoxel-node-compute-spike"),
            ..Default::default()
        })
        .await
        .map_err(|error| format!("request_device: {error}"))?;

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("static-saxpy"),
        source: wgpu::ShaderSource::Wgsl(Cow::Borrowed(include_str!("saxpy.wgsl"))),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("static-saxpy"),
        layout: None,
        module: &shader,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });

    let x_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("x"),
        contents: bytemuck::cast_slice(&X),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let y_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("y"),
        contents: bytemuck::cast_slice(&Y),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("output"),
        size: size_of_val(&X) as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("readback"),
        size: size_of_val(&X) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let params = [2.0f32.to_bits(), X.len() as u32, 0, 0];
    let params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("params"),
        contents: bytemuck::cast_slice(&params),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("static-saxpy"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: x_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: y_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: output_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 3,
                resource: params_buffer.as_entire_binding(),
            },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("static-saxpy"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("static-saxpy"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(
        &output_buffer,
        0,
        &readback_buffer,
        0,
        size_of_val(&X) as u64,
    );
    queue.submit(Some(encoder.finish()));

    let slice = readback_buffer.slice(..);
    let (sender, receiver) = oneshot::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = sender.send(result);
    });
    device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|error| format!("poll: {error}"))?;
    receiver
        .await
        .map_err(|_| "map_async callback dropped".to_owned())?
        .map_err(|error| format!("map_async: {error}"))?;
    let values = {
        let mapped = slice
            .get_mapped_range()
            .map_err(|error| format!("mapped range: {error}"))?;
        bytemuck::cast_slice::<u8, f32>(&mapped).to_vec()
    };
    readback_buffer.unmap();

    Ok(SaxpyResult {
        accelerated_path_engaged: true,
        adapter_name: info.name,
        backend: format!("{:?}", info.backend),
        device_type: format!("{:?}", info.device_type),
        values,
    })
}
