# 매출 분석 수정 설계서

작성일: 2026-09-23  
상위 기획: `docs/122-sales-analysis-ui-ux-data-improvement-plan-2026-09-23.md`  
목표 기준 브랜치: 최신 `origin/main`

## 1. 문서 목적

이 문서는 매출 분석 보완 기획을 실제 코드와 DB 변경 단위로 변환한 구현 설계서다. 화면 배치만 변경하지 않고, 사용자가 보는 매출 수치의 수집 범위·완결 상태·정정 이력을 함께 보장하는 것을 목표로 한다.

구현 범위:

- 완료된 월~일 주간 매출과 전주 비교
- 데이터 수집 범위 및 완결 상태 표시
- KPI 절대/비율 증감
- 일별 지표 비교와 날짜 상세
- 메뉴별 수량·판매액·증감
- 동기화와 화면 재조회 행동 분리
- 권한, 캐시, 오류, 모바일, 접근성 보완

이번 범위에서 제외:

- AI 수요 예측
- 메뉴 원가 및 메뉴별 순이익
- 날씨·행사와 매출의 인과 추정
- 직원 개인 성과와 매출 연결
- 카드·계좌 실제 결제 실행

## 2. 구현 기준과 브랜치 주의사항

### 2.1 기준 구현

최신 `origin/main`을 화면 기준으로 사용한다.

- 주간 화면: `src/features/operations/OperationsFeedback.jsx`
- 집계 함수: `shared/operations.js`
- 조회 API: `server/api/operations-feedback.js`
- 매출 수집: `server/api/sync-sales.js`
- 클라이언트 API: `src/features/operations/operationsApi.js`
- 스타일: `src/features/operations/operations.css`
- 테스트: `test/operations-feedback.test.js`

### 2.2 병합 시 반드시 해결할 차이

현재 작업 브랜치 `codex/expense-evidence-card-sprint1`의 `ea34e99`에는 다음 수정이 있으나 최신 `origin/main`의 수집기에는 모두 유지되지 않았다.

- KST 오후 10시 수집 범위 계산
- 기간 동기화
- 500건 단위 다중 페이지 수집
- 페이지 상한 도달 시 성공 처리 방지
- `last_successful_window_from/to` 기록
- 당일 수집 상태와 화면 캐시 우회

따라서 구현 브랜치는 `origin/main`에서 생성하고, `ea34e99` 전체를 무조건 체리픽하지 않는다. 아래 파일의 필요한 로직만 비교 적용한다.

- `server/api/sync-sales.js`
- `server/api/finance-report.js`
- `src/lib/supabase.js`
- `supabase/migrations/20260915000200_tossplace_sales_sync_window.sql`

`20260915000200` 마이그레이션은 이미 최신 main에 존재하므로 새로 만들거나 이름을 중복 사용하지 않는다.

## 3. 전체 구조

```text
Vercel Cron / 관리자 수동 동기화
        │
        ▼
server/api/sync-sales.js
        │  Toss Place 페이지 반복 조회
        ├──────────────► tossplace_orders 원주문 upsert
        │
        ├──────────────► sales_sync_runs 실행 이력
        │
        └──────────────► 일별 매출 집계 refresh
                              │
                              ▼
server/api/operations-feedback.js
        │  선택 주 + 비교 주 범위 검증
        │  원주문/일별 집계/수집 실행 대조
        ▼
WeeklySalesResponse
        │
        ▼
SalesAnalyticsPage
  ├─ SalesPeriodHeader
  ├─ SalesMetricGrid
  ├─ SalesInsight
  ├─ DailySalesChart
  ├─ DailySalesDrawer
  ├─ MenuSalesTable
  └─ SalesDataStatusPanel
```

## 4. DB 수정 설계

신규 마이그레이션 이름:

`supabase/migrations/20260923000100_sales_sync_runs_and_finalization.sql`

### 4.1 동기화 실행 이력

신규 테이블: `timefit_user_sales_sync_runs`

```sql
create table public.timefit_user_sales_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  merchant_id bigint not null,
  requested_mode text not null check (requested_mode in ('daily', 'range', 'backfill')),
  window_from timestamptz not null,
  window_to timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  pages_fetched integer not null default 0,
  orders_received integer not null default 0,
  page_complete boolean not null default false,
  summary_refresh_completed boolean not null default false,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed', 'partial')),
  error_code text,
  error_message text,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_to >= window_from)
);

create index timefit_user_sales_sync_runs_org_window_idx
  on public.timefit_user_sales_sync_runs
  (organization_id, merchant_id, window_from, window_to, completed_at desc);
```

정책:

- 서비스 역할만 쓰기 허용
- 조직 최고관리자와 `sales.view` 권한자는 읽기 가능
- API는 서비스 역할로 읽고 조직 권한 확인 후 필요한 상태만 반환
- 원본 credential, access key, secret은 절대 저장하지 않음

### 4.2 일별 매출 집계 확장

기존 `timefit_user_tossplace_daily_sales`에 다음 필드를 추가한다.

```sql
alter table public.timefit_user_tossplace_daily_sales
  add column if not exists cancelled_order_count integer not null default 0,
  add column if not exists last_source_synced_at timestamptz,
  add column if not exists finalization_status text not null default 'pending',
  add column if not exists revision_number integer not null default 0,
  add column if not exists source_fingerprint text;
```

`finalization_status` 허용값:

- `pending`: 22시 전 또는 수집 없음
- `captured`: 22시 1차 수집 성공
- `finalized`: 후속 재수집과 대조 완료
- `revised`: 확정 뒤 수치 변경
- `incomplete`: 부분 실패 또는 합계 불일치

### 4.3 지문과 정정 판정

일별 지문 입력:

```text
sales_date
completed_order_count
cancelled_order_count
completed_amount
sorted(order_id + state + total_amount + updated_at)
```

이전 `finalized` 지문과 새 지문이 다르면:

- `revision_number += 1`
- `finalization_status = 'revised'`
- 실행 이력 `result_summary.changed_dates`에 날짜와 전/후 합계 기록

지문은 원본 역산용이 아니라 변경 감지용이다. 민감한 주문 상세를 지문 필드에 저장하지 않는다.

## 5. 수집기 수정 설계

대상: `server/api/sync-sales.js`

### 5.1 수집 범위

```js
dailySalesSyncRange(now)
```

- 타임존: `Asia/Seoul`
- 기본 시작: 전일 00:00 KST
- 기본 종료: 당일 22:00 KST와 실제 실행 시각 중 빠른 값
- 오후 10시 이후 실행돼도 당일 22:00을 넘는 주문을 당일 1차 스냅샷에 섞지 않음
- 다음 날 재수집은 전일 변경 주문과 취소를 확인하는 보정 실행으로 기록

수동 기간 동기화:

- 시작일 00:00 KST
- 종료일 23:59:59.999 KST
- 최대 366일
- 관리자 입력 날짜 형식을 서버에서 검증

### 5.2 페이지 수집

```text
size = 500
page = 1부터 증가
응답 건수 < size이면 page_complete = true
상한에 도달했는데 마지막 응답이 size와 같으면 partial/failed
```

페이지 상한은 조용히 성공 처리하지 않는다. 범위가 큰 백필은 일/월 단위 작업으로 분할한다.

### 5.3 실행 상태 전이

```text
running
 ├─ 모든 페이지 + 원주문 저장 + 집계 갱신 성공 → succeeded
 ├─ 원주문 일부 저장, 다음 페이지/집계 실패       → partial
 └─ 원주문 저장 전 실패                         → failed
```

`succeeded` 조건:

- 페이지 완주
- 모든 upsert 성공
- 일별 집계 refresh 성공
- 실행 이력 완료 기록 성공

연결 테이블의 `last_synced_at`은 `succeeded`일 때만 갱신한다.

### 5.4 수집 응답

```json
{
  "ok": true,
  "runId": "uuid",
  "mode": "range",
  "window": {
    "from": "2026-09-14T00:00:00+09:00",
    "to": "2026-09-20T23:59:59.999+09:00"
  },
  "pagesFetched": 3,
  "ordersReceived": 1032,
  "pageComplete": true,
  "changedDates": ["2026-09-15"]
}
```

클라이언트는 HTTP 성공만으로 화면을 확정 상태로 만들지 않는다. `pageComplete`와 후속 조회의 상태를 확인한다.

## 6. 주간 집계 설계

대상: `shared/operations.js`

기존 `weeklySales`를 다음 단위로 분리한다.

```js
summarizeSalesPeriod({ orders, dailyRows, from, to })
evaluateSalesCoverage({ runs, dailyRows, from, to, now })
buildMenuSalesComparison({ currentOrders, previousOrders })
buildWeeklySalesReport(input)
```

### 6.1 기간 요약

각 날짜별 반환값:

```js
{
  date,
  weekday,
  completedRevenue,
  completedOrders,
  cancelledOrders,
  averageOrderValue,
  cachedCompletedRevenue,
  cachedCompletedOrders,
  cacheMatched,
  dataStatus
}
```

기간 합계는 일별 합계를 다시 합산하고, 원주문 직접 합계와 일치하는지 검증한다.

### 6.2 완결 상태 판정

선택 주 또는 비교 주가 `finalized`가 되려면 모두 충족해야 한다.

1. 성공한 sync run의 범위가 기간 전체를 포함한다.
2. `page_complete = true`다.
3. 해당 7일의 일별 집계 행이 존재한다.
4. 원주문 완료 건수/금액과 일별 캐시가 일치한다.
5. 실행 오류가 해당 기간의 성공 실행보다 나중에 발생하지 않았다.

상태 우선순위:

```text
error > incomplete > revised > captured > finalized
```

전주 비교 허용:

```js
comparable = current.status in ['finalized', 'revised']
  && previous.status in ['finalized', 'revised'];
```

`revised`는 비교할 수 있지만 UI에 변경 사실을 표시한다.

### 6.3 증감 계산

```js
absoluteDelta = current - previous
percentDelta = previous > 0 ? absoluteDelta / previous * 100 : null
```

- 표시 반올림: 비율 소수점 1자리
- 내부 계산은 원 단위 정수 유지
- 전주 0이면 퍼센트 대신 `비교 기준값 없음`
- 주문 0이면 주문당 금액은 `null`, 0원으로 표시하지 않음

### 6.4 메뉴 집계

식별 키:

```js
menuKey = line.item?.id
  || line.item?.code
  || `${normalize(line.item?.title)}:${normalize(category)}`;
```

집계 필드:

- `menuKey`
- `name`
- `category`
- `quantity`
- `orderCount`
- `grossSalesAmount`
- `salesShare`
- `previousQuantity`
- `previousSalesAmount`
- `quantityDelta`
- `salesDelta`

가격이 0 이하인 품목은 유료 메뉴 순위에서 제외한다. 할인 배부가 불명확하면 필드 이름을 `품목 표시 판매액`으로 표시하고 도움말을 제공한다.

## 7. 조회 API 설계

대상: `server/api/operations-feedback.js`

기존 경로를 유지한다.

```http
GET /api/operations-feedback?scope=weekly&organizationId=...&from=2026-09-14
```

서버 처리 순서:

1. 사용자 인증
2. 조직 및 `sales.view` 권한 확인
3. `from`이 월요일이며 완료된 주인지 확인
4. 조직과 연결 merchant 범위 확정
5. 선택 주 + 비교 주 원주문 전체 페이지 조회
6. 일별 집계 조회
7. 기간을 포함하는 sync run 조회
8. 공유 집계 함수 실행
9. 민감한 raw order를 제거한 DTO 반환

응답 계약:

```ts
type SalesDataState =
  | 'pending'
  | 'captured'
  | 'finalized'
  | 'revised'
  | 'incomplete'
  | 'error';

type WeeklySalesResponse = {
  period: {
    from: string;
    to: string;
    comparisonFrom: string;
    comparisonTo: string;
    timezone: 'Asia/Seoul';
    cutoffHour: 22;
  };
  status: {
    state: SalesDataState;
    comparable: boolean;
    lastSyncedAt: string | null;
    coveredFrom: string | null;
    coveredTo: string | null;
    pageComplete: boolean;
    cacheMatched: boolean;
    revisionCount: number;
    errorMessage: string | null;
  };
  current: SalesPeriodSummary;
  previous: SalesPeriodSummary;
  deltas: SalesMetricDeltas;
  daily: DailySalesComparison[];
  menus: MenuSalesComparison[];
};
```

캐시 헤더:

```http
Cache-Control: private, no-store
```

클라이언트 메모리 캐시는 최대 2분까지 허용하되 수동 동기화 완료 후 해당 조직·기간 키를 삭제한다.

## 8. 프런트엔드 컴포넌트 설계

기존 `WeeklyFeedback` 한 파일의 긴 JSX를 아래처럼 분리한다.

```text
src/features/sales/
  SalesAnalyticsPage.jsx
  SalesPeriodHeader.jsx
  SalesMetricGrid.jsx
  SalesInsight.jsx
  DailySalesChart.jsx
  DailySalesDrawer.jsx
  MenuSalesTable.jsx
  SalesDataStatusPanel.jsx
  salesApi.js
  salesFormat.js
  sales.css
```

홈의 간단 요약은 `WeeklyFeedback`에 유지할 수 있지만, 상세 매출 화면은 `SalesAnalyticsPage`를 사용한다. 집계 로직은 JSX 파일에 두지 않는다.

### 8.1 `SalesAnalyticsPage`

상태:

```js
selectedFrom
activeMetric      // revenue | orders | average
activeTab         // daily | menus
selectedDate
menuQuery
menuCategory
menuSort
refreshRevision
syncState
```

역할:

- URL 또는 navigation context의 시작 주 초기화
- 기간 이동
- 조회/동기화 상태 조정
- 하위 컴포넌트에 DTO 전달
- 화면 이탈 후 돌아왔을 때 선택 주와 탭 복원

### 8.2 `SalesPeriodHeader`

표시:

- `2026.09.14 월 – 09.20 일`
- `전주 동일 요일 대비`
- 상태 칩
- 이전/다음/최근 마감 주
- 최신 매출 동기화

버튼 규칙:

- 다음 주가 완료된 주를 넘으면 비활성
- 동기화 중 기간 이동 버튼은 사용할 수 있지만 동기화 버튼은 비활성
- `최신 매출 동기화`는 서버 수집 호출
- `화면 다시 조회`는 오류/상태 패널 안에서만 제공

### 8.3 `SalesMetricGrid`

4개 KPI:

- 완료 매출
- 완료 주문
- 주문당 금액
- 취소 주문

각 카드 데이터:

```js
label
value
previousValue
absoluteDelta
percentDelta
trend // up | down | flat | unavailable
```

매출 감소를 자동으로 오류 색상으로 처리하지 않는다. 위/아래 화살표와 부호를 제공하고, 순수 정보 변화 색상은 중립 청록/회색을 기본으로 한다.

### 8.4 `DailySalesChart`

초기 구현은 외부 차트 패키지 없이 기존 CSS 막대를 개선한다.

- 7행 쌍대 막대
- 지표 토글
- 현재 주/비교 주 범례
- 정확한 값 텍스트
- 날짜 버튼 전체가 키보드 포커스 가능
- `aria-label`에 날짜, 현재값, 비교값, 증감 포함

차트 라이브러리 도입은 이후 30일/연간 시계열이 필요할 때 검토한다.

### 8.5 `DailySalesDrawer`

- 데스크톱: 오른쪽 드로어
- 모바일: 전체 폭 하단 시트 또는 본문 확장
- ESC와 닫기 버튼 지원
- 열릴 때 제목으로 포커스 이동, 닫을 때 원래 날짜 버튼으로 복귀

일자 상세 조회는 주간 응답에 포함된 요약으로 즉시 열고, 주문 목록이 필요할 때만 추가 API를 호출한다.

### 8.6 `MenuSalesTable`

- 기본 10개
- 검색, 카테고리, 정렬
- 모바일은 열을 숨기지 않고 카드형 행으로 재배치
- 메뉴 클릭 시 일별 추이를 펼침
- 메뉴 코드가 없으면 `이름 기준 집계` 배지

### 8.7 `SalesDataStatusPanel`

문제가 없으면 한 줄로 접는다.

```text
마감 완료 · 09.22 22:24 수집 · 09.07–09.20 범위 · 원주문/집계 일치
```

문제가 있으면 자동으로 펼치고 원인과 행동을 제공한다.

```text
수집 불완전
09.18 데이터가 수집 범위에 포함되지 않았습니다.
[해당 기간 다시 동기화]
```

## 9. 화면 배치 수치

데스크톱 1440px 이상:

- 페이지 최대 폭: 기존 레이아웃 유지
- 상단 소개 영역 최소 높이: 120px 이내
- 상세 카드 패딩: 24px
- KPI: 4열
- 차트/요약: 8:4 또는 차트 전체 폭
- 첫 900px 높이에 헤더, KPI, 차트 시작이 보이도록 구성

태블릿 701–1024px:

- KPI 2×2
- 헤더 행동 두 줄 허용
- 날짜 상세는 본문 아래 확장 가능

모바일 320–700px:

- KPI 1열 또는 핵심 매출 1열 + 보조 KPI 2열
- 기간 이동 버튼 최소 터치 높이 44px
- 큰 금액은 `clamp()`로 축소
- 드로어는 전체 폭
- 메뉴 표는 카드형 행

## 10. 로딩·오류·빈 상태

| 상태 | 화면 처리 |
|---|---|
| 최초 로딩 | 헤더 유지, KPI/차트 영역 스켈레톤 |
| 백그라운드 재조회 | 기존 값 유지, `최신 상태 확인 중` 표시 |
| 동기화 중 | 진행 상태와 대상 기간 표시, 기존 확정값 유지 |
| 연결 없음 | 운영 설정 POS 연결 이동 버튼 |
| 완료 주문 없음 | `완료 주문 없음`, 주문당 금액은 `—` |
| 비교 주 없음 | 현재 값만 표시, 증감/자동 인사이트 숨김 |
| 부분 수집 | `수록된 매출`로 명명, 퍼센트 숨김 |
| 조회 오류 | 마지막 성공 데이터 유지, 조회 시각과 재시도 표시 |
| 동기화 오류 | 화면 조회는 가능, 오류 원인과 재동기화 표시 |

`0원`, `없음`, `미수집`, `오류`를 같은 값으로 처리하지 않는다.

## 11. 권한 설계

권한:

- `sales.view`: 주간 요약, 일별, 메뉴 조회
- `sales.sync`: 수동 동기화
- 조직 최고관리자: 두 권한 모두

서버가 권한을 보장한다. 버튼 숨김만으로 권한을 처리하지 않는다.

일자 상세 주문 응답에서 제외할 값:

- access key/secret
- raw credential
- 결제 PAN 또는 민감 결제 식별자
- 불필요한 전체 `raw_order`

주문 상세는 화면에 필요한 ID, 시각, 상태, 주문 금액, 출처, 정규화된 품목만 반환한다.

## 12. 접근성 및 문구

권장 문구:

- `매출 수집 요청` → `최신 매출 동기화`
- `새로고침` → `화면 다시 조회`
- `마지막 수집` → `POS 수집 완료`
- 불완전한 합계 → `수록된 완료 매출`
- 정상 합계 → `완료 매출`

접근성:

- 상승/하락은 색상뿐 아니라 `▲`, `▼`, 부호로 표시
- 상태 칩에 텍스트 포함
- 탭은 `aria-selected` 또는 `aria-pressed` 일관 적용
- 차트 날짜는 버튼으로 제공
- 라이브 동기화 문구는 `aria-live="polite"`
- 오류는 `role="alert"`
- 키보드 포커스 링 유지

## 13. 수정 대상 파일

### 기존 수정

- `server/api/sync-sales.js`
- `server/api/operations-feedback.js`
- `shared/operations.js`
- `src/main.jsx`
- `src/features/operations/OperationsFeedback.jsx`
- `src/features/operations/operationsApi.js`
- `src/features/operations/operations.css`
- `src/lib/supabase.js`
- `test/operations-feedback.test.js`
- `test/sales-sync-range.test.js`

### 신규 생성

- `supabase/migrations/20260923000100_sales_sync_runs_and_finalization.sql`
- `src/features/sales/SalesAnalyticsPage.jsx`
- `src/features/sales/SalesPeriodHeader.jsx`
- `src/features/sales/SalesMetricGrid.jsx`
- `src/features/sales/SalesInsight.jsx`
- `src/features/sales/DailySalesChart.jsx`
- `src/features/sales/DailySalesDrawer.jsx`
- `src/features/sales/MenuSalesTable.jsx`
- `src/features/sales/SalesDataStatusPanel.jsx`
- `src/features/sales/salesApi.js`
- `src/features/sales/salesFormat.js`
- `src/features/sales/sales.css`
- `test/sales-analysis.test.js`

파일 분리는 구현 과정에서 지나친 추상화가 생기면 일부를 병합할 수 있다. 단, 집계 로직과 화면 JSX는 분리한다.

## 14. 테스트 설계

### 단위 테스트

- KST 완료 주 계산
- 22시 수집 범위
- 전주 0원 증감
- 주문 0건 주문당 금액
- 완료/취소 분리
- 원주문/캐시 불일치
- 수집 범위 미포함
- 페이지 부분 수집
- 확정 뒤 주문 상태 변경
- 메뉴 코드 우선 집계
- 같은 이름/다른 코드 분리
- 이름 변경/같은 코드 연결

### API 테스트

- 조직과 merchant 이중 범위 제한
- `sales.view` 없는 계정 403
- `sales.sync` 없는 계정 수동 동기화 403
- 미래 또는 진행 중 주 거부
- raw order 미노출
- 500건 초과 페이지 전체 조회
- 부분 실패 시 `incomplete`

### 컴포넌트 테스트

- 정상/불완전/재집계/오류 상태
- KPI 절대·비율 차이
- 기간 이동 비활성 조건
- 탭/지표 전환
- 날짜 상세 열기/닫기와 포커스 복귀
- 메뉴 검색·필터·정렬

### 브라우저 UAT

- 1440×900, 1024×768, 390×844, 320×568
- 정상 완료 주
- 비교 기간 없음
- 동기화 실패
- POS 연결 없음
- 완료 주문 0건
- 500건 이상 기간
- 키보드만으로 전체 조작

## 15. 구현 순서와 커밋 단위

1. `feat: record sales sync run coverage`
   - DB 실행 이력 및 일별 상태
2. `fix: paginate and bound Toss sales sync`
   - 22시 범위, 기간 동기화, 페이지 완주
3. `feat: validate weekly sales completeness`
   - 공유 집계 함수와 API DTO
4. `refactor: split weekly sales analysis components`
   - 컴포넌트 분리, 기존 동작 보존
5. `feat: improve sales KPI and daily comparison UX`
   - 새 헤더, KPI, 차트, 상태 패널
6. `feat: add daily drilldown and menu comparison`
   - 날짜 상세, 메뉴 표
7. `test: cover sales finalization and responsive UX`
   - 테스트 및 UAT 문서

각 단계는 테스트와 빌드가 통과한 뒤 다음 단계로 이동한다. DB 적용과 프로덕션 배포는 코드 검증 후 별도 단계로 수행한다.

## 16. 배포 및 롤백

배포 순서:

1. 최신 `origin/main` 기반 작업 브랜치 생성
2. 신규 마이그레이션 로컬/격리 DB 검증
3. 서버 수집기와 조회 API 배포
4. 기존 UI로 API 호환성 확인
5. 신규 UI 배포
6. 운영 사업장 한 곳에서 완료 주/전주 원본 대조
7. 전체 사업장 활성화

기능 플래그 권장:

```text
VITE_SALES_ANALYSIS_V2=true
```

롤백:

- 프런트 기능 플래그로 기존 주간 화면 복귀
- 신규 테이블과 컬럼은 즉시 삭제하지 않음
- 구 UI에서도 기존 API 필드를 유지하도록 응답 호환 계층 제공
- 수집기 실패 시 이전 확정 일별 집계를 보존

## 17. 완료 정의

아래를 모두 충족해야 개발 완료로 판단한다.

- 선택 주와 비교 주의 실제 수집 범위가 확인된다.
- 페이지 일부만 수집된 경우 완료 매출로 표시하지 않는다.
- 원주문과 캐시의 건수 및 금액이 일치한다.
- 오후 10시 기준, 후속 정정, 재집계 상태가 구분된다.
- KPI에 현재값, 비교값, 절대 차이, 비율 차이가 표시된다.
- 일별 변화에서 매출·주문·주문당 금액을 확인할 수 있다.
- 날짜에서 원인 주문으로 이동할 수 있다.
- 메뉴는 안정 식별자로 집계된다.
- 매출 조회/동기화 권한이 서버에서 분리된다.
- 데스크톱과 모바일 UAT가 통과한다.
- 전체 자동 테스트와 프로덕션 빌드가 통과한다.

이 완료 정의 전에는 숫자가 화면에 보인다는 이유만으로 매출 분석 기능을 완성 처리하지 않는다.
