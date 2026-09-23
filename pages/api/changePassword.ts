import { NextApiRequest, NextApiResponse } from 'next';
import { put } from '@vercel/blob';
import { getAuth, getCurrentPassword, safeEqual } from './_auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const authError = await getAuth(req);
  if (authError) return res.status(401).json({ error: authError });

  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }

  try {
    const currentPwd = await getCurrentPassword();
    if (!currentPwd) {
      return res.status(500).json({ error: 'Password not configured' });
    }
    if (typeof currentPassword !== 'string' || !safeEqual(currentPassword, currentPwd)) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    await put('admin-password/pwd.json', JSON.stringify({ password: newPassword }), {
      access: 'public',
      contentType: 'application/json',
    });

    return res.status(200).json({ message: '密码修改成功' });
  } catch (err) {
    return res.status(500).json({ error: '修改失败' });
  }
}
