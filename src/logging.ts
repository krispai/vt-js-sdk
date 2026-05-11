import { ISDKStates, LogLevel } from "./types";

/**
 * Logging service with state transition tracking
 */
export class LoggingService {
  private currentLevel: LogLevel;

  constructor(logLevel: LogLevel = LogLevel.NONE) {
    this.currentLevel = logLevel;
  }

  setLogLevel(level: LogLevel): void {
    this.currentLevel = level;
  }

  setState(oldState: ISDKStates, newState: ISDKStates): void {
    if (oldState !== newState) {
      this.debug(`State transition: ${oldState} → ${newState}`);
    }
  }

  debug(...args: any[]): void {
    if (this.currentLevel >= LogLevel.DEBUG) {
      console.debug("KRISP_VT_SDK [DEBUG]: ", ...args);
    }
  }

  info(...args: any[]): void {
    if (this.currentLevel >= LogLevel.INFO) {
      console.log("KRISP_VT_SDK [INFO]: ", ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.currentLevel >= LogLevel.WARN) {
      console.warn("KRISP_VT_SDK [WARN]: ", ...args);
    }
  }

  error(...args: any[]): void {
    if (this.currentLevel >= LogLevel.ERROR) {
      console.error("KRISP_VT_SDK [ERROR]: ", ...args);
    }
  }
}

