export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'BUCKET_NOT_EMPTY'
  | 'PAYLOAD_TOO_LARGE'
  | 'CHECKSUM_MISMATCH'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_HEALTHY_NODES'
  | 'STORAGE_UNAVAILABLE'
  | 'UPLOAD_FAILED'
  | 'BUCKET_PROTECTED'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static unauthenticated(msg = 'Authentication required') {
    return new AppError(401, 'UNAUTHENTICATED', msg);
  }
  static forbidden(msg = 'You do not have permission to do that') {
    return new AppError(403, 'FORBIDDEN', msg);
  }
  static notFound(msg = 'Not found') {
    return new AppError(404, 'NOT_FOUND', msg);
  }
  static validation(msg: string, details?: unknown) {
    return new AppError(400, 'VALIDATION_ERROR', msg, details);
  }
  static conflict(msg: string) {
    return new AppError(409, 'CONFLICT', msg);
  }
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; requestId?: string; details?: unknown };
}
