# API 함수 정리 및 배포 검증

## 문제와 변경

- 기준: `main` 병합 커밋 `526e183`.
- 기존 `api/`에는 공개 엔드포인트 26개와 내부 헬퍼·Provider를 포함해 JavaScript 파일 33개가 있었다. Vercel Hobby의 배포당 Serverless Function 12개 제한 때문에 프로덕션 배포가 실패했다.
- 공개 URL `/api/{경로}`와 각 핸들러의 HTTP 메서드·인증·응답 계약은 유지한다.
- 구현 33개 파일을 `server/api/`로 이동하고, `api/[...route].js` 한 개만 Vercel 함수 진입점으로 둔다.
- 오래된 `.vercelignore`의 개별 API 제외 규칙을 제거했다. 이제 제외됐던 재무 API도 라우터에서 접근 가능하므로 각 핸들러의 권한 검사에 의존한다.
- 예약 작업 URL `/api/sync-sales`, `/api/check-attendance-alerts`, `/api/payroll-notifications`는 그대로 유지한다.

## 라우팅 목록

| 영역 | 기존 URL 경로 |
| --- | --- |
| 매출·토스 | `tossplace`, `tossplace-bootstrap-connection`, `tossplace-custom-credentials`, `sync-sales`, `sales-dashboard`, `menu-sales-dashboard`, `organization-sales-dashboard` |
| 지출·결산 | `expenses`, `expense-detail`, `expense-review`, `expense-exceptions`, `expense-reminder-worker`, `receipt-process`, `finance-report`, `closeouts` |
| 카드 연결 | `card-connections`, `card-connection-assets`, `card-connection-history`, `card-connection-reauth`, `card-sync`, `card-sync-worker` |
| 운영·직원 | `operations-feedback`, `staff-sensitive-profile`, `check-attendance-alerts`, `payroll-notifications`, `send-settlement-email` |

## 검증 및 남은 작업

- `npm test`: 57개 통과. 단일 함수 파일, 기존 URL 라우팅, 404, 카드·재무 API 계약을 확인했다.
- `npm run build`: 통과.
- Vercel 프리뷰 배포: `Not authorized`로 거부되어 실제 Vercel 라우팅과 함수 수 확인은 미완료.
- Vercel 권한 해결 후 프리뷰에서 `GET /api/tossplace`, 인증되지 않은 재무 API, 존재하지 않는 경로의 404, 세 예약 URL을 확인한다. 그 후 프로덕션 배포한다.
- 한 함수로 통합하면 여러 엔드포인트가 동일한 최대 실행 시간·번들·배포 단위를 공유한다. 추후 트래픽이나 실행 시간에 따라 12개 이내의 도메인별 함수로 분할할 수 있다.
