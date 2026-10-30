// SPDX-License-Identifier: Apache-2.0
namespace PicoVoxel.Tests;

/// <summary>
/// The reference evaluator, mirroring <c>dEvalOne</c> in <c>src/pico-tape.cpp</c>: every operation in
/// double, the last instruction's register is the signed distance, and the caller rounds to float once.
/// </summary>
/// <remarks>
/// It exists so that a lifted method can be compared against the author's own method here, without a wasm
/// build. Only the operations the lifter admits are implemented; anything else is a test failure rather
/// than a silent result.
/// </remarks>
internal static class TapeEvaluator
{
    internal static float Evaluate(uint[] instructions, double[] constants, float x, float y, float z)
    {
        var count = instructions.Length / 2;
        var registers = new double[count];
        for (var i = 0; i < count; i++)
        {
            var op = instructions[2 * i];
            var operands = instructions[(2 * i) + 1];
            var a = (int)(operands & 0xFFFF);
            var b = (int)(operands >> 16);
            registers[i] = op switch
            {
                0 => constants[a],
                1 => x,
                2 => y,
                3 => z,
                4 => registers[a] + registers[b],
                5 => registers[a] - registers[b],
                6 => registers[a] * registers[b],
                7 => registers[a] / registers[b],
                8 => -registers[a],
                9 => Math.Abs(registers[a]),
                10 => Math.Sqrt(registers[a]),
                11 => Math.Sin(registers[a]),
                12 => Math.Cos(registers[a]),
                13 => Math.Floor(registers[a]),
                _ => throw new InvalidOperationException($"The lifter emitted opcode {op}, which it must not."),
            };
        }
        return (float)registers[count - 1];
    }
}
