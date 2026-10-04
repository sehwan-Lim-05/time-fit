# TimeFit

직원 출퇴근, 스케줄, 휴가·연차, 급여 관리를 위한 1차 관리자 웹 애플리케이션 골격입니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 터미널에 표시되는 로컬 주소를 엽니다.

## 구성

- `docs/01-product-plan.md`: 서비스 1차 기획서
- `pages/`: Next.js 화면 및 통합 API 라우트 진입점
- `src/main.jsx`: 대시보드와 화면 전환을 포함한 클라이언트 UI
- `src/styles.css`: 반응형 관리자 UI 스타일

현재 프론트엔드는 브라우저 상태 기반의 MVP이며, API와 PostgreSQL 스키마는 `backend/`에 분리했습니다.

운영 API는 `pages/api/[...route].js` 한 함수에서 기존 `/api/*` 경로를 유지하며, 기능별 핸들러는 `server/routes/`에 모여 있습니다. 클라이언트 공개 환경 변수는 `NEXT_PUBLIC_*`를 사용합니다. 기존 Vercel의 `VITE_SUPABASE_*` 설정은 `next.config.mjs`에서 전환 기간 동안만 대체값으로 읽습니다. 서버 비밀값은 공개 접두사를 붙이지 않습니다.

## 백엔드·데이터베이스

기능 목록과 1차 데이터 모델 검증은 [02-feature-validation.md](docs/02-feature-validation.md)에서 확인할 수 있습니다. Prisma/PostgreSQL 스키마와 Express API 골격은 [backend/README.md](backend/README.md)에 안내되어 있습니다.

관리자·직원 관점의 상세 업무 흐름과 향후 역할 권한 분리 계획은 [03-user-scenarios.md](docs/03-user-scenarios.md)에서 확인할 수 있습니다.

배포 화면에서 수행한 역할별 브라우저 테스트와 개선 우선순위는 [04-scenario-test-feedback.md](docs/04-scenario-test-feedback.md)에 정리되어 있습니다.

최신 배포 UI를 기준으로 정리한 역할별 2차 사용 흐름과 수용 기준은 [05-user-scenarios-v2.md](docs/05-user-scenarios-v2.md)에서 확인할 수 있습니다.

2차 시나리오에 대한 배포 화면 브라우저 테스트 결과는 [06-scenario-v2-test-report.md](docs/06-scenario-v2-test-report.md)에 정리되어 있습니다.

Supabase 스키마, RLS, QR 출퇴근 Edge Function 및 적용 절차는 [07-supabase-qr-architecture.md](docs/07-supabase-qr-architecture.md)에서 확인할 수 있습니다.

운영용 백엔드·DB 확정 스펙과 기존 Prisma 초안의 전환 상태는 [08-supabase-backend-spec.md](docs/08-supabase-backend-spec.md)에 정리되어 있습니다.
