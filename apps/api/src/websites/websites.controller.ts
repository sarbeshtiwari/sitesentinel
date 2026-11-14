import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import {
  CreateWebsiteInput, DeleteWebsiteInput, MonitoringPauseInput, RequestTransferInput, UpdateSdkConfigInput, UpdateWebsiteInput, Uuid, VerifyWebsiteInput, WebsitePreviewInput,
} from "@wim/contracts";
import { Client, CurrentOrg, CurrentSession, parse, RequirePermission, type ClientInfo, type OrgContext, type SessionContext } from "../common/context.js";
import { WebsitesService } from "./websites.service.js";

const id = (v: string) => parse(Uuid, v);

@Controller("api/v1/orgs/:orgId")
export class WebsitesController {
  constructor(private readonly websites: WebsitesService) {}

  @Get("websites")
  @RequirePermission("website:read")
  async list(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.websites.list(s, o) };
  }

  @Post("websites/preview")
  @RequirePermission("website:write")
  @HttpCode(200)
  async preview(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown) {
    return { data: await this.websites.preview(s, o, parse(WebsitePreviewInput, body).url) };
  }

  @Post("websites")
  @RequirePermission("website:write")
  async create(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.create(s, o, parse(CreateWebsiteInput, body), c) };
  }

  @Get("websites/:websiteId")
  @RequirePermission("website:read")
  async get(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.websites.detail(s, o, id(w)) };
  }

  @Patch("websites/:websiteId")
  @RequirePermission("website:write")
  async update(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.update(s, o, id(w), parse(UpdateWebsiteInput, body), c) };
  }

  /** Destructive: requires website:delete and typing the domain. Body-carrying POST rather than DELETE. */
  @Post("websites/:websiteId/delete")
  @RequirePermission("website:delete")
  @HttpCode(204)
  async remove(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    await this.websites.remove(s, o, id(w), parse(DeleteWebsiteInput, body).confirmHost, c);
  }

  // ---------------------------------------------------------------- monitoring (Phase 4B)
  @Get("websites/:websiteId/monitoring")
  @RequirePermission("website:read")
  async monitoring(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.websites.monitoring(s, o, id(w)) };
  }

  @Post("websites/:websiteId/monitoring/pause")
  @RequirePermission("website:write")
  @HttpCode(200)
  async pauseMonitoring(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.setMonitoringPaused(s, o, id(w), parse(MonitoringPauseInput, body).paused, c) };
  }

  @Post("websites/:websiteId/executions/:executionId/cancel")
  @RequirePermission("website:write")
  @HttpCode(200)
  async cancelExecution(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Param("executionId") e: string, @Client() c: ClientInfo) {
    return { data: await this.websites.cancelExecution(s, o, id(w), id(e), c) };
  }

  // ---------------------------------------------------------------- verification
  @Post("websites/:websiteId/verify")
  @RequirePermission("website:write")
  @HttpCode(202)
  async verify(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.requestVerification(s, o, id(w), parse(VerifyWebsiteInput, body).method, c) };
  }

  @Post("websites/:websiteId/verification/token")
  @RequirePermission("website:write")
  @HttpCode(200)
  async regenerateToken(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.regenerateToken(s, o, id(w), c) };
  }

  @Post("websites/:websiteId/verification/restart")
  @RequirePermission("website:write")
  @HttpCode(200)
  async restart(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.restartVerification(s, o, id(w), c) };
  }

  @Get("websites/:websiteId/verifications")
  @RequirePermission("website:read")
  async verifications(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.websites.verifications(s, o, id(w)) };
  }

  @Get("websites/:websiteId/registration-history")
  @RequirePermission("website:read")
  async history(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.websites.registrationHistory(s, o, id(w)) };
  }

  @Get("websites/:websiteId/audit")
  @RequirePermission("audit:read")
  async audit(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string) {
    return { data: await this.websites.websiteAudit(s, o, id(w)) };
  }

  // ---------------------------------------------------------------- SDK
  @Post("websites/:websiteId/installation/check")
  @RequirePermission("website:write")
  @HttpCode(202)
  async checkInstall(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.checkInstallation(s, o, id(w), c) };
  }

  @Post("websites/:websiteId/site-key/regenerate")
  @RequirePermission("website:write")
  @HttpCode(200)
  async regenerateKey(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.regenerateKey(s, o, id(w), c) };
  }

  @Post("websites/:websiteId/site-key/revoke")
  @RequirePermission("website:write")
  @HttpCode(200)
  async revokeKey(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.revokeKey(s, o, id(w), c) };
  }

  @Post("websites/:websiteId/telemetry/pause")
  @RequirePermission("website:write")
  @HttpCode(200)
  async pause(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.setTelemetryPaused(s, o, id(w), true, c) };
  }

  @Post("websites/:websiteId/telemetry/resume")
  @RequirePermission("website:write")
  @HttpCode(200)
  async resume(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Client() c: ClientInfo) {
    return { data: await this.websites.setTelemetryPaused(s, o, id(w), false, c) };
  }

  @Patch("websites/:websiteId/sdk-config")
  @RequirePermission("website:write")
  async sdkConfig(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("websiteId") w: string, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.updateSdkConfig(s, o, id(w), parse(UpdateSdkConfigInput, body), c) };
  }

  // ---------------------------------------------------------------- transfers
  @Get("domain-transfers")
  @RequirePermission("website:read")
  async transfers(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.websites.transfers(s, o) };
  }

  @Post("domain-transfers")
  @RequirePermission("website:write")
  async requestTransfer(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Body() body: unknown, @Client() c: ClientInfo) {
    return { data: await this.websites.requestTransfer(s, o, parse(RequestTransferInput, body).url, c) };
  }

  @Post("domain-transfers/:transferId/verify")
  @RequirePermission("website:write")
  @HttpCode(202)
  async verifyTransfer(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("transferId") t: string, @Client() c: ClientInfo) {
    return { data: await this.websites.verifyTransfer(s, o, id(t), c) };
  }

  @Post("domain-transfers/:transferId/cancel")
  @RequirePermission("website:write")
  @HttpCode(204)
  async cancelTransfer(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("transferId") t: string, @Client() c: ClientInfo) {
    await this.websites.cancelTransfer(s, o, id(t), c);
  }

  @Get("domain-transfers/incoming")
  @RequirePermission("website:read")
  async incoming(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext) {
    return { data: await this.websites.incomingTransfers(s, o) };
  }

  @Post("domain-transfers/incoming/:transferId/contest")
  @RequirePermission("website:write")
  @HttpCode(204)
  async contest(@CurrentSession() s: SessionContext, @CurrentOrg() o: OrgContext, @Param("transferId") t: string, @Client() c: ClientInfo) {
    await this.websites.contestTransfer(s, o, id(t), c);
  }
}
