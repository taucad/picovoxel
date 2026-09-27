#include <webgpu/webgpu.h>

#include <emscripten.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

EM_JS(void, ReportResult, (int ok), {
    globalThis['__emdawnResult'] = { ok: Boolean(ok) };
    globalThis['__emdawnDone'] = true;
});

namespace
{

WGPUInstance        g_oInstance = nullptr;
WGPUAdapter         g_oAdapter = nullptr;
WGPUDevice          g_oDevice = nullptr;
WGPUQueue           g_oQueue = nullptr;
WGPUBuffer          g_oInput = nullptr;
WGPUBuffer          g_oOutput = nullptr;
WGPUBuffer          g_oParameters = nullptr;
WGPUBuffer          g_oReadback = nullptr;
WGPUShaderModule    g_oShader = nullptr;
WGPUComputePipeline g_oPipeline = nullptr;
WGPUBindGroup       g_oBindGroup = nullptr;

WGPUStringView StringView(const char* psz)
{
    return {.data = psz, .length = WGPU_STRLEN};
}

void Fail(const char* psz)
{
    std::fprintf(stderr, "EMDAWN_FAIL=%s\n", psz);
    ReportResult(0);
}

void ReleaseResources()
{
    if (g_oBindGroup)  wgpuBindGroupRelease(g_oBindGroup);
    if (g_oPipeline)   wgpuComputePipelineRelease(g_oPipeline);
    if (g_oShader)     wgpuShaderModuleRelease(g_oShader);
    if (g_oReadback)   wgpuBufferRelease(g_oReadback);
    if (g_oParameters) wgpuBufferRelease(g_oParameters);
    if (g_oOutput)     wgpuBufferRelease(g_oOutput);
    if (g_oInput)      wgpuBufferRelease(g_oInput);
    if (g_oQueue)      wgpuQueueRelease(g_oQueue);
    if (g_oDevice)     wgpuDeviceRelease(g_oDevice);
    if (g_oAdapter)    wgpuAdapterRelease(g_oAdapter);
    if (g_oInstance)   wgpuInstanceRelease(g_oInstance);
}

void OnMapped(
    WGPUMapAsyncStatus nStatus,
    WGPUStringView,
    void*,
    void*)
{
    if (nStatus != WGPUMapAsyncStatus_Success)
    {
        Fail("map");
        return;
    }
    const float* pfValues = static_cast<const float*>(
        wgpuBufferGetConstMappedRange(g_oReadback, 0, 4 * sizeof(float)));
    const float afValues[4] = {
        pfValues ? pfValues[0] : -1.f,
        pfValues ? pfValues[1] : -1.f,
        pfValues ? pfValues[2] : -1.f,
        pfValues ? pfValues[3] : -1.f,
    };
    const bool bOk =
        pfValues != nullptr &&
        afValues[0] == 2.f &&
        afValues[1] == 4.f &&
        afValues[2] == 6.f &&
        afValues[3] == 8.f;
    wgpuBufferUnmap(g_oReadback);
    std::printf(
        "EMDAWN_RESULT=%s values=%.1f,%.1f,%.1f,%.1f\n",
        bOk ? "OK" : "FAIL",
        afValues[0],
        afValues[1],
        afValues[2],
        afValues[3]);
    ReportResult(bOk ? 1 : 0);
    ReleaseResources();
}

void OnCompilationInfo(
    WGPUCompilationInfoRequestStatus nStatus,
    const WGPUCompilationInfo* poInfo,
    void*,
    void*)
{
    if (nStatus != WGPUCompilationInfoRequestStatus_Success || poInfo == nullptr)
    {
        Fail("compilation-info");
        return;
    }
    for (size_t i = 0; i < poInfo->messageCount; ++i)
    {
        const WGPUCompilationMessage& oMessage = poInfo->messages[i];
        std::fprintf(
            oMessage.type == WGPUCompilationMessageType_Error ? stderr : stdout,
            "WGSL:%llu:%llu %.*s\n",
            oMessage.lineNum,
            oMessage.linePos,
            (int) oMessage.message.length,
            oMessage.message.data);
    }
}

WGPUBuffer CreateBuffer(uint64_t nSize, WGPUBufferUsage nUsage)
{
    WGPUBufferDescriptor oDescriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    oDescriptor.size = nSize;
    oDescriptor.usage = nUsage;
    return wgpuDeviceCreateBuffer(g_oDevice, &oDescriptor);
}

void RunCompute()
{
    std::ifstream oFile("/emdawn-hello-compute.wgsl");
    const std::string strShader(
        (std::istreambuf_iterator<char>(oFile)),
        std::istreambuf_iterator<char>());
    if (strShader.empty())
    {
        Fail("static-wgsl");
        return;
    }

    WGPUShaderSourceWGSL oSource = WGPU_SHADER_SOURCE_WGSL_INIT;
    oSource.code = {.data = strShader.data(), .length = strShader.size()};
    WGPUShaderModuleDescriptor oShaderDescriptor =
        WGPU_SHADER_MODULE_DESCRIPTOR_INIT;
    oShaderDescriptor.nextInChain = &oSource.chain;
    g_oShader = wgpuDeviceCreateShaderModule(g_oDevice, &oShaderDescriptor);
    WGPUCompilationInfoCallbackInfo oCompilation =
        WGPU_COMPILATION_INFO_CALLBACK_INFO_INIT;
    oCompilation.mode = WGPUCallbackMode_AllowSpontaneous;
    oCompilation.callback = OnCompilationInfo;
    wgpuShaderModuleGetCompilationInfo(g_oShader, oCompilation);

    WGPUComputePipelineDescriptor oPipeline =
        WGPU_COMPUTE_PIPELINE_DESCRIPTOR_INIT;
    oPipeline.compute.module = g_oShader;
    oPipeline.compute.entryPoint = StringView("main");
    g_oPipeline = wgpuDeviceCreateComputePipeline(g_oDevice, &oPipeline);
    if (!g_oPipeline)
    {
        Fail("pipeline");
        return;
    }

    g_oInput = CreateBuffer(
        4 * sizeof(float),
        WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst);
    g_oOutput = CreateBuffer(
        4 * sizeof(float),
        WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
    g_oParameters = CreateBuffer(
        4 * sizeof(uint32_t),
        WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    g_oReadback = CreateBuffer(
        4 * sizeof(float),
        WGPUBufferUsage_MapRead | WGPUBufferUsage_CopyDst);
    const float afInput[4] = {1.f, 2.f, 3.f, 4.f};
    const uint32_t anParameters[4] = {4, 0, 0, 0};
    wgpuQueueWriteBuffer(g_oQueue, g_oInput, 0, afInput, sizeof(afInput));
    wgpuQueueWriteBuffer(
        g_oQueue,
        g_oParameters,
        0,
        anParameters,
        sizeof(anParameters));

    WGPUBindGroupLayout oLayout =
        wgpuComputePipelineGetBindGroupLayout(g_oPipeline, 0);
    WGPUBindGroupEntry aoEntries[3] = {
        WGPU_BIND_GROUP_ENTRY_INIT,
        WGPU_BIND_GROUP_ENTRY_INIT,
        WGPU_BIND_GROUP_ENTRY_INIT,
    };
    aoEntries[0].binding = 0;
    aoEntries[0].buffer = g_oInput;
    aoEntries[0].size = 4 * sizeof(float);
    aoEntries[1].binding = 1;
    aoEntries[1].buffer = g_oOutput;
    aoEntries[1].size = 4 * sizeof(float);
    aoEntries[2].binding = 2;
    aoEntries[2].buffer = g_oParameters;
    aoEntries[2].size = 4 * sizeof(uint32_t);
    WGPUBindGroupDescriptor oBindGroup = WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    oBindGroup.layout = oLayout;
    oBindGroup.entryCount = 3;
    oBindGroup.entries = aoEntries;
    g_oBindGroup = wgpuDeviceCreateBindGroup(g_oDevice, &oBindGroup);
    wgpuBindGroupLayoutRelease(oLayout);

    WGPUCommandEncoderDescriptor oEncoderDescriptor =
        WGPU_COMMAND_ENCODER_DESCRIPTOR_INIT;
    WGPUCommandEncoder oEncoder =
        wgpuDeviceCreateCommandEncoder(g_oDevice, &oEncoderDescriptor);
    WGPUComputePassDescriptor oPassDescriptor =
        WGPU_COMPUTE_PASS_DESCRIPTOR_INIT;
    WGPUComputePassEncoder oPass =
        wgpuCommandEncoderBeginComputePass(oEncoder, &oPassDescriptor);
    wgpuComputePassEncoderSetPipeline(oPass, g_oPipeline);
    wgpuComputePassEncoderSetBindGroup(
        oPass,
        0,
        g_oBindGroup,
        0,
        nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(oPass, 1, 1, 1);
    wgpuComputePassEncoderEnd(oPass);
    wgpuCommandEncoderCopyBufferToBuffer(
        oEncoder,
        g_oOutput,
        0,
        g_oReadback,
        0,
        4 * sizeof(float));
    WGPUCommandBufferDescriptor oCommandDescriptor =
        WGPU_COMMAND_BUFFER_DESCRIPTOR_INIT;
    WGPUCommandBuffer oCommand =
        wgpuCommandEncoderFinish(oEncoder, &oCommandDescriptor);
    wgpuQueueSubmit(g_oQueue, 1, &oCommand);
    wgpuCommandBufferRelease(oCommand);
    wgpuComputePassEncoderRelease(oPass);
    wgpuCommandEncoderRelease(oEncoder);

    WGPUBufferMapCallbackInfo oMap = WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
    oMap.mode = WGPUCallbackMode_AllowSpontaneous;
    oMap.callback = OnMapped;
    wgpuBufferMapAsync(
        g_oReadback,
        WGPUMapMode_Read,
        0,
        4 * sizeof(float),
        oMap);
}

void OnDevice(
    WGPURequestDeviceStatus nStatus,
    WGPUDevice oDevice,
    WGPUStringView,
    void*,
    void*)
{
    if (nStatus != WGPURequestDeviceStatus_Success)
    {
        Fail("device");
        return;
    }
    g_oDevice = oDevice;
    g_oQueue = wgpuDeviceGetQueue(g_oDevice);
#ifndef PICOVOXEL_BLOCKING_WAIT
    RunCompute();
#endif
}

WGPUFuture RequestDevice(WGPUCallbackMode nMode)
{
    WGPULimits oSupported = WGPU_LIMITS_INIT;
    wgpuAdapterGetLimits(g_oAdapter, &oSupported);
    WGPULimits oRequired = WGPU_LIMITS_INIT;
    oRequired.maxComputeInvocationsPerWorkgroup =
        std::min<uint32_t>(256, oSupported.maxComputeInvocationsPerWorkgroup);
    oRequired.maxStorageBufferBindingSize =
        std::min<uint64_t>(256ull * 1024 * 1024, oSupported.maxStorageBufferBindingSize);
    oRequired.maxBufferSize =
        std::min<uint64_t>(512ull * 1024 * 1024, oSupported.maxBufferSize);
    oRequired.maxComputeWorkgroupsPerDimension =
        std::min<uint32_t>(65535, oSupported.maxComputeWorkgroupsPerDimension);
    oRequired.maxComputeWorkgroupStorageSize =
        std::min<uint32_t>(32768, oSupported.maxComputeWorkgroupStorageSize);
    std::printf(
        "EMDAWN_LIMITS invocations=%u storage=%llu buffer=%llu workgroups=%u shared=%u\n",
        oRequired.maxComputeInvocationsPerWorkgroup,
        oRequired.maxStorageBufferBindingSize,
        oRequired.maxBufferSize,
        oRequired.maxComputeWorkgroupsPerDimension,
        oRequired.maxComputeWorkgroupStorageSize);

    WGPUDeviceDescriptor oDescriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    oDescriptor.requiredLimits = &oRequired;
    WGPURequestDeviceCallbackInfo oCallback =
        WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    oCallback.mode = nMode;
    oCallback.callback = OnDevice;
    return wgpuAdapterRequestDevice(g_oAdapter, &oDescriptor, oCallback);
}

void OnAdapter(
    WGPURequestAdapterStatus nStatus,
    WGPUAdapter oAdapter,
    WGPUStringView,
    void*,
    void*)
{
    if (nStatus != WGPURequestAdapterStatus_Success)
    {
        Fail("adapter");
        return;
    }
    g_oAdapter = oAdapter;
#ifndef PICOVOXEL_BLOCKING_WAIT
    RequestDevice(WGPUCallbackMode_AllowSpontaneous);
#endif
}

WGPUFuture RequestAdapter(WGPUCallbackMode nMode)
{
    WGPURequestAdapterOptions oOptions = WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    oOptions.powerPreference = WGPUPowerPreference_HighPerformance;
    WGPURequestAdapterCallbackInfo oCallback =
        WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    oCallback.mode = nMode;
    oCallback.callback = OnAdapter;
    return wgpuInstanceRequestAdapter(g_oInstance, &oOptions, oCallback);
}

#ifdef PICOVOXEL_BLOCKING_WAIT
bool Wait(WGPUFuture oFuture)
{
    WGPUFutureWaitInfo oWait = WGPU_FUTURE_WAIT_INFO_INIT;
    oWait.future = oFuture;
    return
        wgpuInstanceWaitAny(g_oInstance, 1, &oWait, UINT64_MAX) ==
            WGPUWaitStatus_Success &&
        oWait.completed;
}
#endif

} // namespace

int main()
{
#ifdef PICOVOXEL_BLOCKING_WAIT
    const WGPUInstanceFeatureName nFeature =
        WGPUInstanceFeatureName_TimedWaitAny;
    WGPUInstanceLimits oLimits = WGPU_INSTANCE_LIMITS_INIT;
    oLimits.timedWaitAnyMaxCount = 1;
    WGPUInstanceDescriptor oDescriptor = WGPU_INSTANCE_DESCRIPTOR_INIT;
    oDescriptor.requiredFeatureCount = 1;
    oDescriptor.requiredFeatures = &nFeature;
    oDescriptor.requiredLimits = &oLimits;
    g_oInstance = wgpuCreateInstance(&oDescriptor);
    if (
        !g_oInstance ||
        !Wait(RequestAdapter(WGPUCallbackMode_WaitAnyOnly)) ||
        !g_oAdapter ||
        !Wait(RequestDevice(WGPUCallbackMode_WaitAnyOnly)) ||
        !g_oDevice)
    {
        Fail("wait-any");
        return 1;
    }
    RunCompute();
#else
    g_oInstance = wgpuCreateInstance(nullptr);
    if (!g_oInstance)
    {
        Fail("instance");
        return 1;
    }
    RequestAdapter(WGPUCallbackMode_AllowSpontaneous);
#endif
    return 0;
}
