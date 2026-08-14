import { ROLE_TEMPLATES } from '../config/permissions'

export const mockUsers = [
  {
    id: 'U001',
    name: 'Founder',
    employeeId: 'FOUNDER001',
    role: 'founder',
    team: '全部',
    assignedTeams: ['全部'],
    otpRequired: true,
    ...ROLE_TEMPLATES.founder
  },
  {
    id: 'U002',
    name: 'Amy',
    employeeId: 'WD000021',
    role: 'assistant',
    team: '管理助理',
    assignedTeams: ['PH客服支持组', 'AR印度'],
    otpRequired: true,
    ...ROLE_TEMPLATES.assistant
  },
  {
    id: 'U003',
    name: 'Randi F',
    employeeId: 'WD000053',
    role: 'team_leader',
    team: 'PH客服支持组',
    assignedTeams: ['PH客服支持组'],
    otpRequired: false,
    ...ROLE_TEMPLATES.team_leader
  },
  {
    id: 'U004',
    name: 'Jodie',
    employeeId: 'JA525122101',
    role: 'employee',
    team: 'PH客服支持组',
    assignedTeams: ['PH客服支持组'],
    otpRequired: true,
    ...ROLE_TEMPLATES.employee
  }
]

export const employeeProfile = {
  employeeId: 'JA525122101',
  name: 'Jodie Reyes',
  country: '菲律宾',
  employeeType: 'pure_home_ph',
  team: 'PH客服支持组',
  position: '线上培训',
  directLeader: 'Randi F',
  trainer: 'Amy',
  payout: {
    method: 'GCash',
    accountName: 'JODIE REYES',
    accountNumber: '0917 123 4567',
    bankName: '',
    network: '',
    address: ''
  }
}

export const payoutRequests = [
  {
    id: 'REQ202608140001',
    employeeId: 'JA525122101',
    employeeName: 'Jodie Reyes',
    team: 'PH客服支持组',
    employeeType: 'pure_home_ph',
    oldPayout: {
      method: 'GCash',
      accountName: 'JODIE REYES',
      accountNumber: '0917 123 4567'
    },
    newPayout: {
      method: 'Maya',
      accountName: 'JODIE REYES',
      accountNumber: '0918 888 8888'
    },
    reason: '原 GCash 手机号已停用，需要更换到新的 Maya 账号。',
    note: '本人账号',
    otpVerified: true,
    submittedAt: '2026-08-14 15:42',
    status: 'pending'
  },
  {
    id: 'REQ202608130014',
    employeeId: 'WD000081',
    employeeName: 'Stefano B',
    team: 'AR印度',
    employeeType: 'onsite_to_home',
    oldPayout: {
      method: 'USDT',
      network: 'TRC20',
      address: 'TH1JpddZYG****RNAX1'
    },
    newPayout: {
      method: 'USDT',
      network: 'TRC20',
      address: 'TR6PxyzA2****9Yz1'
    },
    reason: '旧钱包无法继续使用。',
    note: '',
    otpVerified: true,
    submittedAt: '2026-08-13 09:18',
    status: 'pending'
  }
]
