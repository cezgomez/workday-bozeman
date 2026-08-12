import { runReportInfo } from './report-info.js';
import { runJobDescription } from './job-description.js';
import { runMarketAdjustment } from './market-adjustment.js';
import { runPayIncrease } from './pay-increase.js';
import { runBenefitAcknowledgement } from './benefit-acknowledgement.js';
import { runIcpBonus } from './icp-bonus.js';
import { runRnExperience } from './rn-experience.js';
import { runJobOffer } from './job-offer.js';
import { runEducation } from './education.js';
import { runWorkplaceTest } from './workplace-test.js';
import { runOtherDocument } from './other-document.js';
import { runBenefitEvent } from './benefit-event.js';
import { runDependentEvent } from './dependent-event.js';
import { runDomesticPartner } from './domestic-partner.js';
import { runElderlyAbuse } from './elderly-abuse.js';
import { runResidentRights } from './resident-rights.js';
import { runCharterPurpose } from './charter-purpose.js';
import { runResumeCoverLetter } from './resume-coverletter.js';
import { runPersonal } from './personal.js';
import { runCertification } from './certification.js';

/**
 * Registry of supported --api values.
 * Add new report handlers here as more Workday APIs are onboarded.
 */
export const apiRegistry = {
  'report-info': runReportInfo,
  'job-description': runJobDescription,
  'market-adjustment': runMarketAdjustment,
  'pay-increase': runPayIncrease,
  'benefit-acknowledgement': runBenefitAcknowledgement,
  'icp-bonus': runIcpBonus,
  'rn-experience': runRnExperience,
  'job-offer': runJobOffer,
  education: runEducation,
  'workplace-test': runWorkplaceTest,
  'other-document': runOtherDocument,
  'benefit-event': runBenefitEvent,
  'dependent-event': runDependentEvent,
  'domestic-partner': runDomesticPartner,
  'elderly-abuse': runElderlyAbuse,
  'resident-rights': runResidentRights,
  'charter-purpose': runCharterPurpose,
  'resume-coverletter': runResumeCoverLetter,
  personal: runPersonal,
  certification: runCertification,
};

export function listApis() {
  return Object.keys(apiRegistry);
}
