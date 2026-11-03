// SPDX-License-Identifier: Apache-2.0
namespace PicoVoxel.Tests;

/// <summary>
/// The reference evaluator, mirroring <c>dEvalOne</c> in <c>src/pico-tape.cpp</c> for every opcode: each
/// coordinate widened to double, every operation in double, the last register rounded to float once.
/// </summary>
/// <remarks>The native fill is checked against <c>dEvalOne</c> itself by test/tape-lift-ops.test.ts.</remarks>
internal static class TapeEvaluator
{
    internal static float Evaluate(uint[] instructions, double[] constants, float x, float y, float z)
    {
        var count = instructions.Length / 2;
        var r = new double[count];
        for (var i = 0; i < count; i++)
        {
            var op = instructions[2 * i];
            var operands = instructions[(2 * i) + 1];
            var a = (int)(operands & 0xFFFF);
            var b = (int)(operands >> 16);
            r[i] = op switch
            {
                0 => constants[a],
                1 => x,
                2 => y,
                3 => z,
                4 => r[a] + r[b],
                5 => r[a] - r[b],
                6 => r[a] * r[b],
                7 => r[a] / r[b],
                8 => -r[a],
                9 => Math.Abs(r[a]),
                10 => Math.Sqrt(r[a]),
                11 => Math.Sin(r[a]),
                12 => Math.Cos(r[a]),
                13 => Math.Floor(r[a]),
                18 => Math.Exp(r[a]),
                19 => Math.Log(r[a]),
                20 => (float)r[a],
                21 => r[a] < r[b] ? 1 : 0,
                22 => r[a] <= r[b] ? 1 : 0,
                23 => r[a] == r[b] ? 1 : 0,
                24 => r[a] != 0 ? r[(int)(instructions[(2 * b) + 1] & 0xFFFF)] : r[(int)(instructions[(2 * b) + 1] >> 16)],
                25 => 0,
                _ => throw new InvalidOperationException($"The lift emitted opcode {op}, which it must not."),
            };
        }
        return (float)r[count - 1];
    }
}
