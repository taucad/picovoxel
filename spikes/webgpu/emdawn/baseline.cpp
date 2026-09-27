#include <emscripten.h>

EM_JS(void, ReportBaseline, (), {
    globalThis['__emdawnResult'] = { ok: true };
    globalThis['__emdawnDone'] = true;
});

int main()
{
    ReportBaseline();
    return 0;
}
