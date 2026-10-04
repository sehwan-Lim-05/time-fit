# 기능별 API 통합과 Next.js 라우팅 전환안

> 2026-09-19 구현 현황: 아래 내용은 최초 설계안이다. 후속 브랜치 `codex/nextjs-api-routing`에서는 기존 Node `req`/`res` 계약을 보존하는 Next.js **Pages API Routes**를 채택했다. 공개 `/api/*` 경로와 네 도메인 레지스트리는 유지하고, `pages/api/[...route].js` 한 진입점으로 연결했다. `/`, `/tablet`, `/sales`는 Next.js Pages로 이전했으며 Vite는 제거했다. `next build`에서 동적 API 라우트 1개가 확인됐고, HTTP 스모크 테스트와 58개 단위 테스트를 통과했다. 운영 전환은 Vercel 프리뷰 및 실제 로그인·Cron·웹훅 검증 후에만 진행한다.

## 결정

현재 Vite 운영 앱을 즉시 Next.js라고 선언하지 않는다. 먼저 PR #3의 Vercel 단일 진입점 아래 API 26개를 **매출·Toss, 지출·결산, 카드, 운영·직원** 4개 도메인 레지스트리로 분리한다. 외부 `/api/*` URL, 요청 메서드, 인증, 응답 및 Cron URL은 유지한다. Next.js 전환은 별도 프리뷰·회귀 테스트를 거치는 후속 단계로 진행한다.

Next.js Route Handler는 `app/api/.../route.js` 파일과 Web `Request`/`Response` 계약을 사용한다. 현재 26개 구현은 Vercel/Node의 `req`/`res` 계약에 의존하므로 파일명만 `route.js`로 바꾸면 작동하지 않는다. 또한 프로젝트가 아직 Vite이므로 `app/api`를 추가하는 것만으로 Next.js 런타임이 켜지지 않는다. [Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers), [Vercel 함수 배포 방식](https://vercel.com/docs/functions/runtimes).

## 현재 기능 경계

| 그룹 | 내부 모듈 | 기존 공개 경로 | 인증/실행상 주의 |
| --- | --- | --- | --- |
| 매출·Toss | `server/routes/sales.js` | Toss 웹훅, 연결·인증정보, 매출 동기화·대시보드 | 웹훅 서명, 연결 키 암호화, 매출 Cron |
| 지출·결산 | `server/routes/finance.js` | 지출, 영수증, 검토, 예외, 결산, 재무 보고서 | 사업장·소유자 권한, 영수증 입력 크기, 알림 Cron |
| 카드 | `server/routes/cards.js` | 카드 연결·재인증·이력·동기화 | 외부 제공자 통신, 중복 실행·재시도 |
| 운영·직원 | `server/routes/operations.js` | 운영 피드백, 직원 민감정보, 출퇴근 알림, 급여 알림, 정산 메일 | 직원 개인정보, 소유자 권한, 알림 Cron |

각 그룹은 기존 핸들러를 참조만 한다. 파일을 합쳐서 인증 규칙까지 혼합하지 않는다. 라우터는 명시적으로 등록한 이름만 호출하며 알 수 없는 경로는 404를 반환한다.

## Next.js 전환 설계

### 1. 배포 가능한 중간 상태

현재 Vite + `api/[...route].js` 단일 함수 구조를 먼저 프리뷰에서 검증한다. 이것만으로 Hobby 함수 12개 제한을 피할 수 있고, Next.js 전환을 장애 복구의 필수 선행조건으로 만들지 않는다.

### 2. Next.js 프로젝트 셸

- `next`, `next build`, `next start` 및 Vercel Framework Preset을 Next.js로 변경한다.
- 관리자 웹의 `/`, `/tablet`, `/sales` 진입을 먼저 동일하게 렌더링한다. 기존 Vite `createRoot`와 전역 CSS·정적 자산·환경 변수(`VITE_*`)를 Next의 클라이언트 컴포넌트 및 `NEXT_PUBLIC_*`로 옮기는 작업이 필요하다.
- 새 Next 프로젝트 프리뷰에서 로그인, 태블릿 URL, 급여·매출 화면이 동일하게 열리기 전에는 운영 도메인을 전환하지 않는다.
- `output: 'export'`는 쓰지 않는다. 동적 POST API와 Cron을 실행할 수 없기 때문이다. [Next.js Backend for Frontend](https://nextjs.org/docs/app/guides/backend-for-frontend).

### 3. API 라우트 이전

권장 최종 구조는 아래와 같다. `app/api`에 그룹별 Route Handler를 두되 하나의 그룹이 무조건 Vercel 함수 하나가 된다고 가정하지 않는다. 실제 빌드 출력에서 함수 수를 확인한다.

```text
app/api/sales/[...action]/route.js
app/api/finance/[...action]/route.js
app/api/cards/[...action]/route.js
app/api/operations/[...action]/route.js
server/domains/{sales,finance,cards,operations}/...
```

기존 URL은 단계적으로 Next `rewrites`를 통해 새 그룹 경로로 연결한다. 요청 본문, 인증 헤더, 원래 URL, 상태 코드, CORS, 웹훅 raw body가 바뀌지 않는지 계약 테스트로 확인한다. 장기적으로 프런트 호출을 그룹 경로로 교체한 뒤 호환 rewrite를 제거한다. 기존 Node 핸들러를 Next Route Handler에서 임시로 감싸는 어댑터는 스트림·멀티파트·웹훅 서명 검증을 보존하기 어렵기 때문에 기본안으로 삼지 않는다. 그룹별 서비스 로직을 Web Request/Response와 분리해서 순차적으로 이전한다.

### 4. 제한과 성능

- Vercel Hobby의 프레임워크 외 직접 `api/` 파일은 각각 함수로 계산된다. Next.js는 동적 코드를 가능한 적은 함수로 묶지만 **항상 4개라는 보장은 없다**. 배포 결과가 12개 이하인지 확인한다. [Vercel Runtimes](https://vercel.com/docs/functions/runtimes).
- Next Route Handler별 `runtime='nodejs'`, `maxDuration`을 실행 특성에 맞게 설정한다. Toss/카드 동기화는 짧은 HTTP 요청과 큐·워커로 분리해 300초에 의존하지 않도록 한다. [Route Segment Config](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config), [Vercel Functions Limits](https://vercel.com/docs/functions/limitations).
- 서버 비밀값은 `NEXT_PUBLIC_*`로 노출하지 않는다. Supabase service role, Toss secret, 카드 제공자 키는 서버 전용 환경 변수로 유지한다.

## 전환 게이트

1. 현재 단일 함수 PR 프리뷰 성공, 26개 경로 목록과 3개 Cron 경로 확인.
2. 도메인별 인증 실패(401/403), 정상 조회, POST 저장, 웹훅 서명, 중복 요청·재시도 회귀 테스트.
3. Next 셸에서 웹 화면/태블릿 fallback과 로그인 회귀 테스트.
4. Next API 프리뷰에서 상태·헤더·응답 본문 비교, 함수 수 ≤12, 실행 시간·번들 크기 확인.
5. 운영 배포 후 제한된 실매장 읽기 검증과 Cron·웹훅 모니터링. 이상 시 이전 Vercel Ready 배포로 되돌린다.

## 현재 상태

단일 함수 기반 도메인 레지스트리 분리는 PR #3에 반영했다. 후속 브랜치에서 Next.js Pages Router 셸과 Pages API Routes 전환을 구현했다. 클라우드 프리뷰와 운영 배포는 아직 수행하지 않았다. 앞선 Vercel 프리뷰는 `Not authorized`로 차단된 이력이 있으므로 계정 권한을 먼저 확인해야 한다.
