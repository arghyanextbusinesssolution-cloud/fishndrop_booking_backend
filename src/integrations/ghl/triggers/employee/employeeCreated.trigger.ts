import { getPublicLinkBase } from "../../config";
import { safeTrigger } from "../../client";
import { splitName, toId } from "../../helpers/common";

/**
 * Admin created an employee (staff) account → GHL sends the employee their login details.
 * Payload: name, email, phone, password, loginUrl (https://www.tropica.nyc/employee-login/).
 * Webhook: employeeAccount (GHL_EMPLOYEE_ACCOUNT_WEBHOOK_URL)
 */
export const sendGHLEmployeeCreatedEvent = async (
  employee: any,
  _createdBy?: any,
  credentials?: { password?: string }
): Promise<void> => {
  await safeTrigger("employee_account_created", () => {
    const { name } = splitName(employee.name);
    return {
      webhook: "employeeAccount",
      event: "employee_account_created",
      ref: toId(employee),
      payload: {
        name,
        email: employee.email || "",
        phone: employee.phone || "",
        password: credentials?.password || "",
        loginUrl: `${getPublicLinkBase()}/employee-login/`
      }
    };
  });
};
