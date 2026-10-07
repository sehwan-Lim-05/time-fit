# 관리자 기능별 권한 기획·설계

## 1. 목적

사업주가 기존 직원 또는 독립 관리자 계정에 업무별 권한을 위임하되, 직원 계정·근무 데이터는 유지하고 허용된 사업장과 담당 범위에서만 기능을 사용할 수 있도록 한다.

권한 판단 순서는 다음과 같다.

1. 계정 상태가 `active`인지 확인한다.
2. 현재 선택한 사업장에 대한 관리자 계정인지 확인한다.
3. 기능 권한을 확인한다.
4. 근무 구분, 직원 또는 비용센터 담당 범위를 확인한다.
5. 조회·변경·승인 API에서 같은 조건을 다시 검증한다.

사업주는 모든 권한을 가진다. 위임 관리자는 명시적으로 부여된 권한만 가진다.

## 2. 기능별 권한 목록

| 영역 | 권한 코드 | 기능 | 민감도 |
| --- | --- | --- | --- |
| 홈 | `dashboard.view` | 사업장 운영 현황과 요약 조회 | 일반 |
| 출퇴근 | `attendance.view` | 출퇴근 기록 및 근태 이상 조회 | 일반 |
| 출퇴근 | `attendance.manage` | 출퇴근 기록 직접 등록·수정 | 높음 |
| 출퇴근 | `attendance.review_correction` | 직원 정정 요청 승인·반려 | 높음 |
| 스케줄 | `schedule.view` | 직원 일정 조회 | 일반 |
| 스케줄 | `schedule.manage` | 일정 작성·수정·삭제 | 높음 |
| 스케줄 | `schedule.approve` | 제출된 일정 승인·반려 | 높음 |
| 휴가 | `leave.view` | 휴가·연차 현황 조회 | 일반 |
| 휴가 | `leave.review` | 휴가 요청 승인·반려 | 높음 |
| 직원 | `employee.view` | 직원 기본정보 조회 | 일반 |
| 직원 | `employee.manage` | 직원 등록·기본정보 수정 | 높음 |
| 직원 보상 | `employee.compensation.view` | 급여 형태와 보상정보 조회 | 매우 높음·추가 예정 |
| 직원 보상 | `employee.compensation.manage` | 급여 형태와 보상정보 수정 | 매우 높음·추가 예정 |
| 급여 | `payroll.view` | 급여·인건비 조회 | 매우 높음 |
| 급여 | `payroll.manage` | 급여 초안 변경·확정 | 매우 높음·추가 예정 |
| 매출 | `sales.view` | 주간 매출과 메뉴 분석 조회 | 높음 |
| 매출 | `sales.sync` | POS 매출 수집·동기화 실행 | 높음 |
| 재무 | `finance.view` | 지출 원장·증빙·결산 조회 | 매우 높음 |
| 재무 | `expense.manage` | 지출 원장 등록·수정 | 매우 높음 |
| 재무 | `expense.receipt.review` | 영수증 OCR 검수·승인·수정 요청 | 높음 |
| 재무 | `expense.card.manage` | 법인카드 연결·동기화 | 매우 높음 |
| 재무 | `expense.closeout.manage` | 결산 기간 마감·재오픈 | 매우 높음 |
| 재무 | `expense.export` | CSV와 증빙 자료 다운로드 | 매우 높음 |
| 설정 | `settings.manage` | 근무·부서·운영 기준 변경 | 매우 높음 |

## 3. 권한 의존 관계

변경 또는 승인 권한을 부여하면 필요한 조회 권한을 서버에서 자동으로 추가한다.

| 선택 권한 | 자동 포함 권한 |
| --- | --- |
| `attendance.manage` | `attendance.view` |
| `attendance.review_correction` | `attendance.view` |
| `schedule.manage` | `schedule.view` |
| `schedule.approve` | `schedule.view` |
| `leave.review` | `leave.view` |
| `employee.manage` | `employee.view` |
| `employee.compensation.manage` | `employee.compensation.view`, `employee.view` |
| `sales.sync` | `sales.view` |
| `expense.manage` | `finance.view` |
| `expense.receipt.review` | `finance.view` |
| `expense.card.manage` | `finance.view` |
| `expense.closeout.manage` | `finance.view` |
| `expense.export` | `finance.view` |
| `payroll.manage` | `payroll.view` |

자동 포함된 권한은 관리자 설정 화면에서 잠금 표시하고, 상위 권한을 해제할 때 다른 의존 권한이 없다면 함께 해제한다.

## 4. 역할별 기본 권한 프리셋

역할은 권한 선택을 돕는 프리셋일 뿐이며, 최종 접근 판단은 개별 권한과 담당 범위를 기준으로 한다.

### 4.1 매장 매니저

기본 권한:

- `dashboard.view`
- `attendance.view`
- `attendance.manage`
- `attendance.review_correction`
- `schedule.view`
- `schedule.manage`
- `schedule.approve`
- `leave.view`
- `leave.review`
- `employee.view`

선택 권한:

- `employee.manage`

급여, 직원 보상정보, 매출, 재무, 운영 설정 권한은 기본적으로 제외한다.

### 4.2 파트 책임자·총괄 셰프

- `dashboard.view`
- `attendance.view`
- `schedule.view`
- `schedule.manage`
- `leave.view`
- `leave.review`
- `employee.view`

지정된 근무 구분에 속한 직원만 접근할 수 있다. 스케줄 승인과 출퇴근 수정은 사업주가 별도로 부여할 때만 허용한다.

### 4.3 회계 담당자

- `payroll.view`
- `sales.view`
- `finance.view`
- `expense.manage`
- `expense.receipt.review`
- `expense.export`

법인카드 연결과 결산 마감은 별도 선택 권한으로 둔다. 직원 인사, 출퇴근 수정, 스케줄 관리는 제외한다.

### 4.4 조회 전용 관리자

- `dashboard.view`
- `attendance.view`
- `schedule.view`
- `leave.view`
- `employee.view`

작성·수정·승인 권한은 제공하지 않는다.

## 5. 담당 범위

### 근무 구분 범위

홀, 주방, 베이커리 등 지정된 근무 구분의 직원만 조회·변경·승인할 수 있다. 범위가 비어 있는 경우 전체 허용으로 해석하지 않고, 역할 정책에 따라 명시적으로 처리한다.

### 직원 범위

기능 실행 시 대상 직원이 관리자의 허용 근무 구분에 포함되는지 서버에서 검증한다.

### 비용센터 범위

재무 권한은 지정된 부서·비용센터의 지출, 카드, 영수증, 결산 자료에만 적용한다.

### 사업장 범위

모든 권한은 현재 선택한 한 사업장에만 적용한다. 다른 사업장으로 전환하면 해당 사업장의 권한을 다시 불러온다.

## 6. 계정 유형과 권한 회수

### 기존 직원 계정 연결

- 기존 아이디와 비밀번호를 그대로 사용한다.
- 직원 앱의 출퇴근·스케줄·휴가 기능을 유지한다.
- 관리자 모드에서만 위임받은 기능을 표시한다.
- 관리자 권한을 회수해도 직원 계정과 근무 데이터는 삭제하지 않는다.

### 독립 관리자 계정

- 직원으로 근무하지 않는 관리자를 위한 별도 계정이다.
- 계정 삭제 시 인증 계정도 삭제할 수 있다.
- 삭제 전에 계정 유형과 삭제 범위를 명확하게 안내한다.

### 중지와 회수

- `suspended`: 관리자 접근을 일시 중지한다.
- 권한 회수: 관리자 연결만 제거하고 직원 계정은 보존한다.
- 앱과 웹은 다음 세션 갱신 시 즉시 직원 모드로 복귀한다.

## 7. 화면 적용 원칙

- 권한이 없는 메뉴, 빠른 메뉴, 생성·수정·승인 버튼은 표시하지 않는다.
- 조회 권한만 있으면 상세 화면은 읽기 전용으로 표시한다.
- 서버 거절에만 의존하지 않고 UI에서도 실행 기능을 숨긴다.
- 민감 권한에는 경고 문구를 표시하고 기본 선택을 해제한다.
- 결산 마감, 카드 연결, 설정 변경에는 재확인 절차를 둔다.
- 권한 변경 후 재로그인 없이 세션을 갱신할 수 있어야 한다.

## 8. 보안 및 감사 기준

- 메뉴 숨김은 보안 수단으로 간주하지 않는다.
- 모든 API, RPC, DB RLS에서 기능 권한과 담당 범위를 재검증한다.
- 사업주 계정과 사업주 권한은 위임 관리자가 변경할 수 없다.
- 권한 부여·수정·중지·재활성화·회수 이력을 기록한다.
- 감사 이력에는 실행자, 대상자, 사업장, 변경 전후 권한, 담당 범위, 시간이 포함되어야 한다.
- 급여, 주민등록번호, 계좌정보는 일반 직원 관리 권한과 분리한다.

## 9. 현재 구현 상태

구현 완료:

- 기존 직원 계정과 관리자 권한 연결
- 관리자 권한 회수 시 직원 계정·근무 데이터 보존
- 활성 관리자만 웹·앱 관리자 컨텍스트 제공
- 기능별 권한과 근무 구분·비용센터 범위 저장
- 관리자 권한 변경 감사 이력 저장
- 웹·모바일 직원/관리자 모드 구분
- 권한별 모바일 관리자 메뉴 노출
- 출퇴근 관리·정정 승인·스케줄 승인 권한 코드 통일
- 변경 권한에 필요한 조회 권한 자동 포함

후속 구현 필요:

- 웹 스케줄 승인 UI에 `schedule.approve` 연결
- 웹 출퇴근 정정 UI에 `attendance.manage` 및 `attendance.review_correction` 연결
- 스케줄 수정 버튼에 `schedule.manage` 적용
- 직원 보상정보 권한과 일반 직원 관리 권한 분리
- `payroll.manage` 도입 시 급여 확정 작업 분리
- 역할별 프리셋 선택 UI
- 자동 포함 권한 잠금·설명 UI
- 권한 변경 후 세션 즉시 갱신
- 권한·범위 조합별 웹·모바일 통합 테스트

## 10. 완료 판정 기준

- DB, 관리자 생성·수정 API, 웹, 모바일이 동일한 권한 코드를 사용한다.
- 변경 권한을 선택하면 필요한 조회 권한이 자동으로 포함된다.
- 권한 없는 메뉴와 버튼이 웹·모바일 모두에서 보이지 않는다.
- 직접 API를 호출해도 서버와 DB에서 차단된다.
- 근무 구분, 직원, 비용센터, 사업장 범위가 모든 기능에 적용된다.
- 중지·회수 후 관리자 접근이 차단되고 직원 기능은 유지된다.
- 기존 근무·급여·출퇴근 데이터가 삭제되지 않는다.
- 모든 권한 변경 이력이 감사 로그에 기록된다.
- 사업주 권한은 위임 관리자에게 노출되거나 위임되지 않는다.
- 권한 조합별 자동화 테스트와 실제 사용자 시나리오 검증을 통과한다.

