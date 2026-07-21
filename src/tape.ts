// TP3 — SdfExpression → tape compiler.
//
// A JS SDF callback is pinned to the main thread (addFunction entries exist only
// in the registering thread's wasm table), which forces upstream's serial fill.
// A serialized expression crosses the boundary once as data and is evaluated
// in-module on every thread by src/pico-tape.cpp. This file owns the JS half
// of that contract: the op list, encoding, and validation are mirrored in the
// C++ TU — instruction i is two u32 words [op, a | (b << 16)], its result
// register is i itself (SSA, dst implicit), operands must reference earlier
// instructions, and the final instruction's register is the SDF value.
//
// Expressions are plain JSON: numbers are constants, 'x'/'y'/'z' the sample
// coordinate in millimetres, and operations are ['op', ...operands] arrays.
// The gyroid from the demo, for example:
//   ['-', ['abs', ['+',
//     ['*', ['sin', ['*', 'x', s]], ['cos', ['*', 'y', s]]],
//     ['*', ['sin', ['*', 'y', s]], ['cos', ['*', 'z', s]]],
//     ['*', ['sin', ['*', 'z', s]], ['cos', ['*', 'x', s]]]]], 0.4]
// JSON-serializability is deliberate: expressions can cross workers, be stored,
// or be generated — none of which a closure can do.

import { PicoError } from './errors.ts';

/** A serializable SDF: a constant, a coordinate, or an operation node. */
export type SdfExpression = number | 'x' | 'y' | 'z' | readonly [SdfOperator, ...SdfExpression[]];

export type SdfOperator =
  | '+' // 2+ operands, left-folded
  | '-' // 1 operand = negation, 2 operands = subtraction
  | '*' // 2+ operands, left-folded
  | '/' // 2 operands
  | 'abs'
  | 'sqrt'
  | 'sin'
  | 'cos'
  | 'floor'
  | 'exp'
  | 'log' // 1 operand each
  | 'mod' // 2 operands, GLSL semantics: a - b*floor(a/b)
  | 'pow' // 2 operands
  | 'min'
  | 'max'; // 2+ operands, left-folded

/** Opcode values shared with src/pico-tape.cpp — never renumber. */
const OP = {
  const: 0, x: 1, y: 2, z: 3,
  add: 4, sub: 5, mul: 6, div: 7,
  neg: 8, abs: 9, sqrt: 10, sin: 11, cos: 12, floor: 13,
  mod: 14, min: 15, max: 16, pow: 17, exp: 18, log: 19,
} as const;

const UNARY: Partial<Record<SdfOperator, number>> = {
  abs: OP.abs, sqrt: OP.sqrt, sin: OP.sin, cos: OP.cos,
  floor: OP.floor, exp: OP.exp, log: OP.log,
};
const BINARY: Partial<Record<SdfOperator, number>> = { '/': OP.div, mod: OP.mod, pow: OP.pow };
const FOLDING: Partial<Record<SdfOperator, number>> = { '+': OP.add, '*': OP.mul, min: OP.min, max: OP.max };

/** Operand indices are u16 fields in the instruction word. */
const MAX_INSTRUCTIONS = 0x10000;

export interface SdfTape {
  /** Two u32 words per instruction: [op, a | (b << 16)]. */
  instructions: Uint32Array;
  /** f64 constant pool, deduplicated. */
  constants: Float64Array;
}

function invalid(detail: string): PicoError {
  return new PicoError(
    'PICO_INVALID_ARGUMENT',
    `Invalid SDF expression: ${detail}. An SdfExpression is a number, 'x' | 'y' | 'z', ` +
      `or ['op', ...operands] — see the SdfExpression type for the operator list.`,
  );
}

/** Compiles an expression tree to the flat tape src/pico-tape.cpp evaluates. */
export function compileSdfExpression(expression: SdfExpression): SdfTape {
  const words: number[] = [];
  const constants: number[] = [];
  const constantIndex = new Map<number, number>();

  const emit = (op: number, a = 0, b = 0): number => {
    if (words.length / 2 >= MAX_INSTRUCTIONS) {
      throw invalid(`more than ${MAX_INSTRUCTIONS} operations`);
    }
    words.push(op, a | (b << 16));
    return words.length / 2 - 1;
  };

  const emitConstant = (value: number): number => {
    let index = constantIndex.get(value);
    if (index === undefined) {
      index = constants.length;
      constants.push(value);
      constantIndex.set(value, index);
    }
    return emit(OP.const, index);
  };

  const compile = (node: SdfExpression): number => {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw invalid(`non-finite constant ${node}`);
      return emitConstant(node);
    }
    if (node === 'x' || node === 'y' || node === 'z') {
      return emit(OP[node]);
    }
    if (!Array.isArray(node) || node.length === 0) {
      throw invalid(`unrecognised node ${JSON.stringify(node)}`);
    }
    const [operator, ...operands] = node as readonly [SdfOperator, ...SdfExpression[]];

    if (operator === '-') {
      if (operands.length === 1) return emit(OP.neg, compile(operands[0]!));
      if (operands.length === 2) return emit(OP.sub, compile(operands[0]!), compile(operands[1]!));
      throw invalid(`'-' takes 1 or 2 operands, got ${operands.length}`);
    }
    const unary = UNARY[operator];
    if (unary !== undefined) {
      if (operands.length !== 1) throw invalid(`'${operator}' takes 1 operand, got ${operands.length}`);
      return emit(unary, compile(operands[0]!));
    }
    const binary = BINARY[operator];
    if (binary !== undefined) {
      if (operands.length !== 2) throw invalid(`'${operator}' takes 2 operands, got ${operands.length}`);
      return emit(binary, compile(operands[0]!), compile(operands[1]!));
    }
    const folding = FOLDING[operator];
    if (folding !== undefined) {
      if (operands.length < 2) throw invalid(`'${operator}' takes 2+ operands, got ${operands.length}`);
      let register = compile(operands[0]!);
      for (const operand of operands.slice(1)) register = emit(folding, register, compile(operand));
      return register;
    }
    throw invalid(`unknown operator '${String(operator)}'`);
  };

  compile(expression);
  return { instructions: new Uint32Array(words), constants: new Float64Array(constants) };
}
