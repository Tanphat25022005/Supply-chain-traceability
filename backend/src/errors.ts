export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ConflictError extends Error {}
export class UnauthorizedError extends Error {}

/** One field that failed validation — `code` is stable so clients can word it themselves. */
export interface FieldIssue {
  field: string;
  code: 'required' | 'unknown_field' | 'not_a_number' | 'below_min' | 'above_max' | 'too_long' | 'not_a_date' | 'invalid_option' | 'not_a_boolean' | 'not_text';
  message: string;
}

/** Well-formed request, but the values break a business rule about their shape (422). */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
  }
}
