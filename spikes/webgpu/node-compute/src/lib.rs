use napi::bindgen_prelude::{Error, Result};
use napi_derive::napi;

#[napi]
pub fn run_saxpy() -> Result<String> {
    pollster::block_on(picovoxel_webgpu_native_core::compute_saxpy())
        .and_then(|result| serde_json::to_string(&result).map_err(|error| error.to_string()))
        .map_err(Error::from_reason)
}
