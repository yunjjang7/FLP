import { Bar as RBar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { Donut } from '../components/Donut';
import { RebalanceCard } from '../components/RebalanceCard';
import { CardLink, SetupLink } from '../components/SetupLink';
import { Badge, Bar, CHART_COLORS, Card, Disclaimer, EmptyState, PageHeader, Stat } from '../components/ui';
import { ASSET_TYPES, NATURE_LABEL, PURPOSE_LABEL, RISK_PROFILES } from '../engine/portfolio';
import { ASSET_CLASSES, allocOf, CLASS_LABEL, hasAlloc, IRP_RISK_CAP, isCappedAsset, riskPct } from '../engine/allocation';
import { RE_USE, reUseOf } from '../engine/realestate';
import { pct, won } from '../lib/format';
import { useFlp } from '../store/FlpContext';

export default function Invest() {
  const d = useFlp();
  if (!d.hasData) return <><PageHeader title="투자 점검" /><EmptyState /></>;
  const s = d.summary;
  const target = RISK_PROFILES[d.profile.riskProfile];
  const fin = d.assets.filter((a) => a.type !== 'realestate');
  // 참고 항목(badge ‘참고’, 예: 등락률 다시 입력 필요)은 주의 개수에 세지 않고 따로
  const counts = { good: 0, caution: 0, danger: 0, note: 0 };
  d.checks.forEach((c) => (c.badge === '참고' ? counts.note++ : counts[c.level]++));
  const safe = 100 - s.investShare;

  return (
    <>
      <PageHeader title="투자 점검" desc={<>자산 구성과 주요 위험요인을 점검합니다. 판정 기준은 <SetupLink tab="criteria" card="점검기준">‘기본 정보 → 점검기준’</SetupLink>에서 바꿀 수 있습니다.</>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><Stat label="금융자산 기대수익률" value={pct(s.portfolioReturn, 1)} sub="금액 가중 평균(연)" /></Card>
        <Card><Stat label="예상 변동성" value={pct(s.portfolioVol, 1)} sub="1년 수익률 표준편차" /></Card>
        <Card><Stat label="투자형 비중" value={pct(s.investShare)} sub={`${target.label} 권장 ${target.investShare}%`} /></Card>
        <Card>
          <div className="text-xs text-muted">점검 결과</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge level="good">양호 {counts.good}</Badge>
            <Badge level="caution">주의 {counts.caution}</Badge>
            <Badge level="danger">위험 {counts.danger}</Badge>
            {counts.note > 0 && <span className="inline-flex shrink-0 items-center rounded-full bg-sunken px-2 py-0.5 text-xs font-semibold text-muted">참고 {counts.note}</span>}
          </div>
        </Card>
      </div>

      <Card title="위험요인 체크리스트" className="mt-4">
        <ul className="divide-y divide-line">
          {d.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <Badge level={c.level}>{c.badge}</Badge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-semibold">{c.label}</span>
                  <span className="text-sm font-bold">{c.value}</span>
                </div>
                <p className="text-xs text-muted">{c.detail}{c.link && <> <CardLink to={c.link.to} card={c.link.card}>{c.link.text}</CardLink></>}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="안전형 · 투자형 (금융자산)">
          <div className="flex h-4 overflow-hidden rounded-full">
            <div className="bg-[var(--chart-6)]" style={{ width: `${safe}%` }} />
            <div className="bg-[var(--chart-1)]" style={{ width: `${s.investShare}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-sm">
            <span>{NATURE_LABEL.safe} <b>{pct(safe)}</b></span>
            <span>{NATURE_LABEL.invest} <b>{pct(s.investShare)}</b></span>
          </div>
          <div className="relative mt-4 h-2 rounded-full bg-sunken">
            <div className="absolute -top-1 h-4 w-0.5 bg-ink" style={{ left: `${target.investShare}%` }} title="권장" />
            <div className="absolute -top-1.5 h-5 w-5 -translate-x-1/2 rounded-full border-2 border-surface bg-brand" style={{ left: `${Math.min(100, s.investShare)}%` }} />
          </div>
          <p className="mt-3 text-xs text-muted">
            세로선은 {target.label} 성향의 권장 투자형 비중({target.investShare}%)입니다. 성향은 <SetupLink tab="profile" card="기본 정보" field="투자 위험성향">‘기본 정보 → 프로필’의 ‘투자 위험성향’</SetupLink>에서 바꿀 수 있습니다.
          </p>
        </Card>
        <Card title="용도별 배치 (금융자산)">
          <Donut data={s.byPurpose} />
        </Card>
      </div>

      <ClassCard />

      <RebalanceCard />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="유형별 비중 (금융자산)">
          <div className="h-60">
            <ResponsiveContainer>
              <BarChart data={s.byType.filter((t) => t.key !== 'realestate')} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid horizontal={false} />
                <XAxis type="number" tickFormatter={(v) => won(v, false)} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="label" width={80} tickLine={false} axisLine={false} />
                <Tooltip formatter={(v: number) => won(v)} cursor={{ fill: 'var(--c-sunken)' }} />
                <RBar dataKey="value" name="금액" radius={[0, 6, 6, 0]} isAnimationActive={false}>
                  {s.byType.filter((t) => t.key !== 'realestate').map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                </RBar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="위험 대비 수익 지도">
          <div className="h-60">
            <ResponsiveContainer>
              <ScatterChart margin={{ left: 0, right: 16, top: 8, bottom: 8 }}>
                <CartesianGrid />
                <XAxis type="number" dataKey="volatility" name="변동성" unit="%" tickLine={false} axisLine={false} />
                <YAxis type="number" dataKey="expectedReturn" name="기대수익률" unit="%" width={40} tickLine={false} axisLine={false} />
                <ZAxis type="number" dataKey="amount" range={[60, 600]} name="금액" />
                <Tooltip
                  cursor={{ strokeDasharray: '3 3' }}
                  content={({ payload }) => {
                    const p = payload?.[0]?.payload as (typeof fin)[number] | undefined;
                    if (!p) return null;
                    return (
                      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs">
                        <div className="font-semibold">{p.name}</div>
                        <div className="text-muted">{won(p.amount)} · 수익 {p.expectedReturn}% · 변동 {p.volatility}%</div>
                      </div>
                    );
                  }}
                />
                <Scatter data={fin} fill="var(--chart-1)" fillOpacity={0.6} isAnimationActive={false} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted">원의 크기는 금액입니다. 오른쪽 위로 갈수록 기대수익과 변동성이 함께 커집니다.</p>
        </Card>
      </div>

      <Card title="보유 자산 상세" className="mt-4">
        <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
          <table className="w-full min-w-[560px] text-sm num-table">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 font-medium">이름</th>
                <th className="font-medium">유형</th>
                <th className="font-medium">용도</th>
                <th className="text-right font-medium">금액</th>
                <th className="text-right font-medium">비중</th>
                <th className="w-28 pl-3 font-medium" />
              </tr>
            </thead>
            <tbody>
              {[...d.assets].sort((a, b) => b.amount - a.amount).map((a) => {
                const share = s.totalAssets > 0 ? (a.amount / s.totalAssets) * 100 : 0;
                return (
                  <tr key={a.id} className="border-b border-line last:border-0">
                    <td className="py-2 font-medium">{a.name}</td>
                    <td className="text-muted">{ASSET_TYPES[a.type].label}</td>
                    <td className="text-muted">{a.type === 'realestate' ? RE_USE[reUseOf(a)] : PURPOSE_LABEL[a.purpose]}</td>
                    <td className="text-right">{won(a.amount)}</td>
                    <td className="text-right">{pct(share, 1)}</td>
                    <td className="pl-3"><Bar value={share} level={share > 40 ? 'caution' : undefined} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      <Disclaimer />
    </>
  );
}

/** 자산군(주식형·채권형·대체·현금성) 구성: 금융자산 전체와 비율을 넣은 계좌별 */
function ClassCard() {
  const { assets, summary: s } = useFlp();
  const rows = assets.filter((a) => a.type !== 'realestate' && a.amount > 0 && hasAlloc(a));
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <Card title="자산군 구성 (금융자산)">
        <Donut data={s.byClass} />
        {s.byAcct.some((g) => g.key !== 'none') && (
          <p className="mt-3 text-sm">주식·펀드·ETF 계좌 구분: {s.byAcct.map((g) => `${g.label} ${won(g.value)}`).join(' · ')}</p>
        )}
        <p className="mt-3 text-xs text-muted">
          계좌 안 자산배분 비율을 넣은 자산은 그 비율로, 넣지 않은 자산은 유형·성격으로 나눴습니다(현금·예금·적금·안전형 → 현금성, 채권 → 채권형, 투자형 → 주식형, 투자형 기타 → 대체). 비율은 <SetupLink tab="assets">기본 정보 → 자산</SetupLink>의 주식·펀드·ETF·연금·기타 자산에서 넣습니다.
        </p>
      </Card>
      <Card title="계좌별 자산배분">
        {rows.length ? (
          <div className="-mx-4 overflow-x-auto px-4 sm:-mx-5 sm:px-5">
            <table className="w-full min-w-[480px] text-sm num-table">
              <thead>
                <tr className="border-b border-line text-right text-xs text-muted">
                  <th className="py-1.5 text-left font-medium">계좌</th>
                  {ASSET_CLASSES.map((k) => <th key={k} className="font-medium">{CLASS_LABEL[k]}</th>)}
                  <th className="font-medium">위험자산</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const x = allocOf(a);
                  const over = isCappedAsset(a) && riskPct(x) > IRP_RISK_CAP * 100 + 0.05;
                  return (
                    <tr key={a.id} className="border-b border-line text-right">
                      <td className="py-1.5 text-left">{a.name}<div className="text-xs text-muted">{won(a.amount)}</div></td>
                      {ASSET_CLASSES.map((k) => <td key={k}>{pct(x[k])}</td>)}
                      <td className={over ? 'font-semibold text-bad' : ''}>{pct(riskPct(x))}{over && <div className="text-xs">{IRP_RISK_CAP * 100}% 한도 초과</div>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted">아직 자산배분 비율을 넣은 계좌가 없습니다. 주식·연금 계좌처럼 한 계좌에 여러 자산군을 담았다면 <SetupLink tab="assets">자산 탭</SetupLink>에서 ‘자산배분 비율’을 넣으세요. 넣으면 투자형 비중·리밸런싱·인출 바구니가 실제 배분을 씁니다.</p>
        )}
      </Card>
    </div>
  );
}
