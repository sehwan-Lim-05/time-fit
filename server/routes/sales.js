import menuSalesDashboard from '../api/menu-sales-dashboard.js';
import organizationSalesDashboard from '../api/organization-sales-dashboard.js';
import salesDashboard from '../api/sales-dashboard.js';
import syncSales from '../api/sync-sales.js';
import tossplace from '../api/tossplace.js';
import tossplaceBootstrapConnection from '../api/tossplace-bootstrap-connection.js';
import tossplaceCustomCredentials from '../api/tossplace-custom-credentials.js';

export const salesRoutes = Object.freeze({
  'menu-sales-dashboard': menuSalesDashboard,
  'organization-sales-dashboard': organizationSalesDashboard,
  'sales-dashboard': salesDashboard,
  'sync-sales': syncSales,
  tossplace,
  'tossplace-bootstrap-connection': tossplaceBootstrapConnection,
  'tossplace-custom-credentials': tossplaceCustomCredentials,
});
