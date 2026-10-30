import { compileSdfExpression } from '../../../src/tape.ts';
import { ImplicitGyroid } from '../../../src/shapekernel.ts';
const { instructions, constants } = compileSdfExpression(new ImplicitGyroid(3, 1).expression);
console.log(JSON.stringify({ instructions: [...instructions], constants: [...constants] }));
