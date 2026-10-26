// A compile-time error that carries a line in the *concatenated* prelude+source
// text. compile() subtracts the prelude offset before showing it to the user.
export class TpError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'TpError';
    this.line = typeof line === 'number' ? line : 1;
  }
}
