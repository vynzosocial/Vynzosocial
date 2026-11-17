import { createClient } from 'npm:@supabase/supabase-js@2.91.0'
import nodemailer from 'npm:nodemailer@10.4.0'
import { handleProblemReport } from './handler.mjs'

const url = Deno.env.get('SUPABASE_URL')
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
const smtpUser = Deno.env.get('REPORT_SMTP_USER')
const smtpPassword = Deno.env.get('REPORT_SMTP_PASSWORD')
if (!url || !serviceKey || !smtpUser || !smtpPassword) throw new Error('Problem report service is not configured.')

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
const transport = nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: smtpUser, pass: smtpPassword },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
})

Deno.serve(request => handleProblemReport(request, {
  async authenticate(req: Request) {
    const token = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return null
    const { data, error } = await admin.auth.getUser(token)
    if (error && (error.status === 401 || error.status === 403)) return null
    if (error) throw error
    return data.user
  },
  async consumeLimit(userId: string) {
    const { data, error } = await admin.rpc('consume_problem_report_limit', { p_user_id: userId })
    if (error) throw error
    return data === true
  },
  async sendMail({ userId, description, attachment }: { userId: string; description: string; attachment?: { filename: string; content: Uint8Array; contentType: string } }) {
    await transport.sendMail({
      from: smtpUser, to: 'vynzolive@gmail.com', subject: 'Vynzo app problem report',
      text: `User ID: ${userId}\n\nProblem:\n${description}`,
      attachments: attachment ? [attachment] : []
    })
  }
}))
