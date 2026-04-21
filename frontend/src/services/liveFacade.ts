import {
  createCategory,
  createChannel,
  createDomain,
  fetchBootstrap,
  fetchChannelMessages,
  fetchDomainPresence,
  fetchMe,
  loginAccount,
  registerAccount,
  sendVerificationCode,
} from "../api";

/**
 * 直播业务门面：统一暴露前端领域所需 API，降低页面对底层接口耦合。
 */
export const liveFacade = {
  createCategory,
  createChannel,
  createDomain,
  fetchBootstrap,
  fetchChannelMessages,
  fetchDomainPresence,
  fetchMe,
  loginAccount,
  registerAccount,
  sendVerificationCode,
};
