import { useMemo } from 'react';
import { Button, Card, EmptyState, PageHeader } from '../components/ui';
import { prescriptions } from '../engine/prescribe';
import { buildReport } from '../engine/report';
import { useFlp } from '../store/FlpContext';
import type { Level } from '../types';

const DOT: Record<Level, string> = { good: 'bg-good', caution: 'bg-warn', danger: 'bg-bad' };

/** 요약 보고서: 계획 전체를 문장으로 정리한 한 장(인쇄용) */
export default function Report() {
  const d = useFlp();
  const nowYear = d.profile.birthYear + d.summary.age;
  const sections = useMemo(() => {
    if (!d.hasData) return [];
    const rx = prescriptions(d.profile, d.basis, d.planInput, d.sim.successRate, d.goalPlans, d.ins, d.retax);
    return buildReport({ profile: d.profile, summary: d.summary, planInput: d.planInput, sim: d.sim, start: d.start, need: d.need, liabilities: d.liabilities, goals: d.goals, checks: d.checks, rx, nowYear, retax: d.retax });
  }, [d, nowYear]);
  if (!d.hasData) return <><PageHeader title="요약 보고서" /><EmptyState /></>;
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  return (
    <div className="report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><PageHeader title="요약 보고서" desc={`${d.profile.name ? `${d.profile.name} · ` : ''}${today} 기준 · 화면마다 흩어진 결과를 한 장의 문장으로 모았습니다. 입력을 바꾸면 함께 바뀝니다.`} /></div>
        <Button variant="ghost" onClick={() => window.print()} className="no-print shrink-0">인쇄·PDF 저장</Button>
      </div>
      <div className="space-y-4">
        {sections.map((sec) => (
          <Card key={sec.title} title={sec.title} className="report-card">
            <ul className="space-y-2 text-sm leading-relaxed">
              {sec.lines.map((l, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden className={`mt-[0.55em] h-1.5 w-1.5 shrink-0 rounded-full ${l.level ? DOT[l.level] : 'bg-muted/50'}`} />
                  <span className="min-w-0">{l.text}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">점 색: 초록 양호 · 주황 주의 · 빨강 위험. 자세한 숫자와 그래프는 노후 진단·맞춤 처방·인출 계획 화면에서 봅니다.</p>
    </div>
  );
}
