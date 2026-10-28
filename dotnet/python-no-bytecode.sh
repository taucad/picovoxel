#!/bin/sh
# Emscripten supplies -E, which ignores Python cache environment variables.
# The explicit -B flag keeps SDK inputs read-only even on a fresh runner.
exec "${PICOGK_PYTHON:-python3}" -B "$@"
