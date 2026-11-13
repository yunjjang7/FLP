import { Component, type ReactNode } from 'react';

/** 화면 하나가 오류로 멈춰도 앱 전체가 빈 화면이 되지 않도록 보호 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <h2 className="text-lg font-bold">이 화면을 표시하는 중 문제가 생겼습니다</h2>
        <p className="mt-2 text-sm text-muted">입력값을 확인하거나 다른 화면으로 이동해 보세요. 데이터는 안전하게 보관되어 있습니다.</p>
        <pre className="mt-3 overflow-auto rounded-lg bg-sunken p-3 text-left text-xs text-muted">{this.state.error.message}</pre>
      </div>
    );
  }
}
