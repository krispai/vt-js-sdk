import type { ICustomError, IErrorPayload, IHooks, ILogger, IErrorHandler } from "./types";
import { VtErrorType } from "./types";

/**
 * Map HTTP status codes to VtErrorType
 */
export function httpStatusToErrorType(status: number): VtErrorType {
  switch (status) {
    case 401:
      return VtErrorType.InvalidAuthToken;
    case 400:
      return VtErrorType.ValidationErrorServer;
    case 500:
    case 503:
      return VtErrorType.InternalErrorServer;
    default:
      return VtErrorType.InternalErrorServer;
  }
}

/**
 * Error handling service for SDK error emission
 */
export class ErrorHandlingService implements IErrorHandler {
  constructor(private hooks: IHooks, private logger: ILogger) {}

  /**
   * Update hooks reference
   */
  setHooks(hooks: IHooks): void {
    this.hooks = hooks;
  }

  /**
   * Emit error through hooks and handle exceptions gracefully
   */
  emitError(
    error: ICustomError | Error,
    code: VtErrorType,
    context: Record<string, any> = {}
  ): void {
    const payload: IErrorPayload = {
      code: code ?? VtErrorType.InternalErrorClient,
      message: error?.message || String(error),
      context,
    };
    try {
      this.hooks.onError?.(payload);
    } catch (_) {
      // Silently catch hook execution errors to prevent cascading failures
    }
  }

  /**
   * Create custom error with code and context
   */
  createCustomError(
    message: string,
    code: VtErrorType,
    context?: Record<string, any>
  ): ICustomError {
    const error = new Error(message) as ICustomError;
    error.code = code;
    error.context = context || {};
    return error;
  }
}
