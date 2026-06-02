import type { ICustomError, ILogger, IErrorHandler, VtLanguageInfo } from "./types";
import { VtErrorType } from "./types";
import { LANGUAGES_URL, VT_MESSAGES } from "./constants";
import { httpStatusToErrorType } from "./error-handling";

/**
 * Krisp REST API service – languages endpoint only.
 * Audio transport is handled by WebSocketTransportService.
 */
export class TranslationAPIService {
  constructor(
    private apiKey: string,
    private logger: ILogger,
    private errorHandler: IErrorHandler
  ) {}

  /**
   * Update error handler reference without recreating the service
   */
  setErrorHandler(errorHandler: IErrorHandler): void {
    this.errorHandler = errorHandler;
  }

  /**
   * Get the list of supported languages for voice translation
   */
  async getLanguagesList(): Promise<VtLanguageInfo[]> {
    try {
      let response: Response;
      try {
        response = await fetch(LANGUAGES_URL, {
          method: "GET",
          headers: {
            Authorization: `API-key ${this.apiKey}`,
          },
        });
      } catch (networkError) {
        const err = new Error(VT_MESSAGES.LANGUAGES_FAILED_NETWORK) as ICustomError;
        err.code = VtErrorType.NetworkError;
        throw err;
      }

      if (!response.ok) {
        const errorCode = httpStatusToErrorType(response.status);
        const errorText = await response.text().catch(() => "");
        const err = new Error(
          `${VT_MESSAGES.LANGUAGES_FAILED}, error code: ${response.status}`
        ) as ICustomError;
        err.code = errorCode;
        err.context = { responseBody: this.parseResponseBody(errorText) };
        throw err;
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data)) {
        const err = new Error(VT_MESSAGES.LANGUAGES_INVALID_RESPONSE) as ICustomError;
        err.code = VtErrorType.ValidationErrorClient;
        err.context = { result };
        throw err;
      }

      return result.data.map((lang: { name: string; language_code: string }) => ({
        code: lang.language_code,
        name: lang.name,
      }));
    } catch (e) {
      const error = e as ICustomError;
      this.logger.error(
        `${VT_MESSAGES.LANGUAGES_FAILED}, error code: ${VtErrorType[error.code ?? VtErrorType.InternalErrorClient]}`,
        error.context
      );
      this.errorHandler.emitError(error, error.code ?? VtErrorType.InternalErrorClient, {
        ...error.context,
      });
      throw e;
    }
  }

  private parseResponseBody(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
