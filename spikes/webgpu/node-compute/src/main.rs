fn main() {
    let result = pollster::block_on(picovoxel_webgpu_native_core::compute_saxpy())
        .and_then(|result| serde_json::to_string(&result).map_err(|error| error.to_string()))
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(1);
        });
    println!("{result}");
}
