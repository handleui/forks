import { captureException } from "@sentry/electron/renderer";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  // Store only the message string to prevent memory leaks from holding Error references
  errorMessage: string | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    // Only store the message, not the full Error object with its stack trace
    // This prevents potential memory leaks from holding error references
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Capture to Sentry - the error reference is released after this call
    captureException(error, {
      contexts: {
        react: {
          componentStack: errorInfo.componentStack,
        },
      },
    });
  }

  // Use class property arrow function to avoid creating new function on each render
  private readonly handleRefresh = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            padding: "24px",
            fontFamily: "system-ui, sans-serif",
            maxWidth: "500px",
            margin: "40px auto",
          }}
        >
          <h1 style={{ fontSize: "20px", marginBottom: "12px" }}>
            Something went wrong
          </h1>
          <p style={{ color: "#666", marginBottom: "16px" }}>
            An unexpected error occurred. Please try refreshing the application.
          </p>
          <pre
            style={{
              background: "#f5f5f5",
              padding: "12px",
              borderRadius: "4px",
              fontSize: "12px",
              overflow: "auto",
            }}
          >
            {this.state.errorMessage ?? "Unknown error"}
          </pre>
          <button
            onClick={this.handleRefresh}
            style={{
              marginTop: "16px",
              padding: "8px 16px",
              background: "#0066cc",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
            type="button"
          >
            Refresh
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
