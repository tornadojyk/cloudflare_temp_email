import { Context, Hono } from 'hono'
import { Jwt } from 'hono/utils/jwt'
import { createMimeMessage } from 'mimetext';
import { Resend } from 'resend';
import { WorkerMailer, WorkerMailerOptions } from 'worker-mailer';

import i18n from '../i18n';
import { CONSTANTS } from '../constants'
import { getJsonSetting, getDomains, getBooleanValue, getJsonObjectValue, getDomainMapValue, getMailDomain, includesDomain } from '../utils';
import { GeoData } from '../models'
import { handleListQuery, isSendMailBindingEnabled, updateAddressUpdatedAt } from '../common'
import { getSendBalanceState, requestSendMailAccess } from './send_balance';
import { ensureSendMailLimit, increaseSendMailLimitCount } from './send_mail_limit_utils';


export const api = new Hono<HonoCustomType>()

api.post('/api/request_send_mail_access', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { address } = c.get("jwtPayload")
    if (!address) {
        return c.text(msgs.AddressNotFoundMsg, 400)
    }
    const result = await requestSendMailAccess(c, address);
    if (result.status === "ok") {
        return c.json({ status: "ok" })
    }
    if (result.status === "already_requested") {
        return c.text(msgs.AlreadyRequestedMsg, 400)
    }
    return c.text(msgs.OperationFailedMsg, 500)
})

export const sendMailToVerifyAddress = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    }
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    const msg = createMimeMessage();
    msg.setSender(from_name ? { name: from_name, addr: address } : address);
    msg.setRecipient(to_name ? { name: to_name, addr: to_mail } : to_mail);
    msg.setSubject(subject);
    msg.addMessage({
        contentType: is_html ? 'text/html' : 'text/plain',
        data: content
    });
    const { EmailMessage } = await import('cloudflare:email');
    const message = new EmailMessage(address, to_mail, msg.asRaw());
    await c.env.SEND_MAIL.send(message);
}

export const sendMailByBinding = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    }
): Promise<void> => {
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    await c.env.SEND_MAIL.send({
        from: from_name ? { email: address, name: from_name } : address,
        to: to_name ? [`${to_name} <${to_mail}>`] : [to_mail],
        subject,
        ...(is_html ? { html: content } : { text: content }),
    });
}

// 修改点 1：将返回值变更为 Promise<string | null>，用于将 Resend 的邮件 ID 往上传递
const sendMailByResend = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    }
): Promise<string | null> => {
    const mailDomain = getMailDomain(address);
    const token = c.env[
        `RESEND_TOKEN_${mailDomain.replace(/\./g, "_").toUpperCase()}`
    ] || c.env.RESEND_TOKEN;
    const resend = new Resend(token);
    const { data, error } = await resend.emails.send({
        from: reqJson.from_name ? `${reqJson.from_name} <${address}>` : address,
        to: reqJson.to_name ? `${reqJson.to_name} <${reqJson.to_mail}>` : reqJson.to_mail,
        subject: reqJson.subject,
        ...(reqJson.is_html ? {
            html: reqJson.content,
        } : {
            text: reqJson.content,
        })
    });
    if (error) {
        throw new Error(`Resend error: ${error.name} ${error.message}`);
    }
    console.log(`Resend success: ${JSON.stringify(data)}`);
    return data?.id || null; // 成功时，将 Resend 分配的发信 ID 返回
}

const sendMailBySmtp = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    },
    smtpOptions: WorkerMailerOptions
): Promise<void> => {
    await WorkerMailer.send(
        smtpOptions,
        {
            from: {
                name: reqJson.from_name,
                email: address
            },
            to: {
                name: reqJson.to_name,
                email: reqJson.to_mail
            },
            subject: reqJson.subject,
            text: reqJson.is_html ? undefined : reqJson.content,
            html: reqJson.is_html ? reqJson.content : undefined
        }
    )
}

export const sendMail = async (
    c: Context<HonoCustomType>, address: string,
    reqJson: {
        from_name: string, to_mail: string, to_name: string,
        subject: string, content: string, is_html: boolean
    },
    options?: {
        isAdmin?: boolean
    }
): Promise<void> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!address) {
        throw new Error(msgs.AddressNotFoundMsg)
    }
    // check domain
    const mailDomain = getMailDomain(address);
    const domains = getDomains(c);
    if (!includesDomain(domains, mailDomain)) {
        throw new Error(msgs.InvalidDomainMsg)
    }
    const sendBalanceState = await getSendBalanceState(c, address, {
        isAdmin: options?.isAdmin,
    });
    if (sendBalanceState.needCheckBalance) {
        if (!sendBalanceState.balance || sendBalanceState.balance <= 0) {
            throw new Error(msgs.NoBalanceMsg)
        }
    }
    const {
        from_name, to_mail, to_name,
        subject, content, is_html
    } = reqJson;
    if (!to_mail) {
        throw new Error(msgs.InvalidToMailMsg)
    }
    // check SEND_BLOCK_LIST_KEY
    const sendBlockList = await getJsonSetting(c, CONSTANTS.SEND_BLOCK_LIST_KEY) as string[];
    if (sendBlockList && sendBlockList.some((item) => to_mail.includes(item))) {
        throw new Error(msgs.AddressBlockedMsg)
    }
    if (!subject) {
        throw new Error(msgs.SubjectEmptyMsg)
    }
    if (!content) {
        throw new Error(msgs.ContentEmptyMsg)
    }
    await ensureSendMailLimit(c);

    // send to verified address list, do not update balance
    const resendEnabled = c.env.RESEND_TOKEN || c.env[
        `RESEND_TOKEN_${mailDomain.replace(/\./g, "_").toUpperCase()}`
    ];
    // send by smtp
    const smtpConfigMap = getJsonObjectValue<Record<string, WorkerMailerOptions>>(c.env.SMTP_CONFIG);
    const smtpConfig = getDomainMapValue(smtpConfigMap, mailDomain);
    // send by verified address list
    let sendByVerifiedAddressList = false;
    if (c.env.SEND_MAIL) {
        const verifiedAddressList = await getJsonSetting(c, CONSTANTS.VERIFIED_ADDRESS_LIST_KEY) || [];
        if (verifiedAddressList.includes(to_mail)) {
            await sendMailToVerifyAddress(c, address, reqJson);
            sendByVerifiedAddressList = true;
        }
    }
    const sendMailBindingEnabled = isSendMailBindingEnabled(c, mailDomain);

    // 修改点 2：新增变量接收外部邮件 ID
    let external_id: string | null = null; 

    // send mail workflow
    if (sendByVerifiedAddressList) {
        // do not update balance
    }
    // send by resend
    else if (resendEnabled) {
        // 捕获 Resend 返回的 ID 
        external_id = await sendMailByResend(c, address, reqJson);
    }
    else if (smtpConfig) {
        await sendMailBySmtp(c, address, reqJson, smtpConfig);
    }
    else if (sendMailBindingEnabled) {
        await sendMailByBinding(c, address, reqJson);
    }
    else {
        throw new Error(`${msgs.EnableResendOrSmtpOrSendMailMsg} (${mailDomain})`);
    }
    await increaseSendMailLimitCount(c);

    // update balance
    if (!sendByVerifiedAddressList && sendBalanceState.needCheckBalance) {
        try {
            const { success } = await c.env.DB.prepare(
                `UPDATE address_sender SET balance = balance - 1 where address = ?`
            ).bind(address).run();
            if (!success) {
                console.warn(`Failed to update balance for ${address}`);
            }
        } catch (e) {
            console.warn(`Failed to update balance for ${address}`);
        }
    }
    // update address updated_at
    updateAddressUpdatedAt(c, address);
    // save to sendbox
    try {
        const reqIp = c.req.raw.headers.get("cf-connecting-ip")
        const geoData = new GeoData(reqIp, c.req.raw.cf as any);
        const body = {
            version: "v2",
            ...reqJson,
            geoData: geoData,
        };
        // 修改点 3：将 external_id 以及 默认发信状态 'sent' 写入 D1 数据库中
        const { success: success2 } = await c.env.DB.prepare(
            `INSERT INTO sendbox (address, raw, external_id, status) VALUES (?, ?, ?, ?)`
        ).bind(address, JSON.stringify(body), external_id, 'sent').run();
        if (!success2) {
            console.warn(`Failed to save to sendbox for ${address}`);
        }
    } catch (e) {
        console.warn(`Failed to save to sendbox for ${address}`, e);
    }
}

api.post('/api/send_mail', async (c) => {
    const { address } = c.get("jwtPayload")
    const reqJson = await c.req.json();
    try {
        await sendMail(c, address, reqJson);
    } catch (e) {
        console.error("Failed to send mail", e);
        return c.text(`Failed to send mail ${(e as Error).message}`, 400)
    }
    return c.json({ status: "ok" })
})

api.post('/external/api/send_mail', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    const { token } = await c.req.json();
    try {
        const { address } = await Jwt.verify(token, c.env.JWT_SECRET, "HS256");
        if (!address) {
            return c.text(msgs.AddressNotFoundMsg, 400)
        }
        const reqJson = await c.req.json();
        await sendMail(c, address as string, reqJson);
        return c.json({ status: "ok" })
    } catch (e) {
        console.error("Failed to send mail", e);
        return c.text(`Failed to send mail ${(e as Error).message}`, 400)
    }
})

export const getSendbox = async (
    c: Context<HonoCustomType>,
    address: string, limit: string, offset: string
): Promise<Response> => {
    if (!address) {
        return c.json({ "error": "No address" }, 400)
    }
    return await handleListQuery(c,
        `SELECT * FROM sendbox where address = ? `,
        `SELECT count(*) as count FROM sendbox where address = ? `,
        [address], limit, offset
    );
}

api.get('/api/sendbox', async (c) => {
    const { address } = c.get("jwtPayload")
    const { limit, offset } = c.req.query();
    return getSendbox(c, address, limit, offset);
})

api.delete('/api/sendbox/:id', async (c) => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        return c.text(msgs.UserDeleteEmailDisabledMsg, 403)
    }
    const { address } = c.get("jwtPayload")
    const { id } = c.req.param();
    const { success } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address = ? and id = ? `
    ).bind(address, id).run();
    return c.json({
        success: success
    })
})

// 修改点 4：直接在此文件末尾，追加 Webhook 公开状态回传路由端点
api.post('/open_api/resend_webhook', async (c) => {
    try {
        const payload = await c.req.json();
        const eventType = payload.type; // 值为 "email.delivered" (送达) 或 "email.bounced" (退信)
        const emailId = payload.data?.email_id; // Resend 对应的发信唯一 ID

        if (emailId && eventType) {
            let status = 'sent';
            if (eventType === 'email.delivered') {
                status = 'delivered'; // 状态更新为：已送达
            } else if (eventType === 'email.bounced') {
                status = 'bounced'; // 状态更新为：退信
            }

            // 将状态实时更新进 D1 数据库的 sendbox 表中
            await c.env.DB.prepare(
                "UPDATE sendbox SET status = ? WHERE external_id = ?"
            ).bind(status, emailId).run();
        }
        return c.json({ success: true });
    } catch (err) {
        console.error("Resend Webhook 处理失败:", err);
        return c.json({ error: "failed" }, 500);
    }
})
