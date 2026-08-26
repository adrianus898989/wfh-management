import assert from 'node:assert/strict'
import test from 'node:test'
import {
  onlineTrainingIdentityKey,
  onlineTrainingReportMatchesTrainer,
  onlineTrainingReportTrainerName,
} from './onlineTrainingIdentity.js'

test('report-level trainer remains authoritative',()=>{
  const report={
    trainer_name:' Trainer A ',author_name:'Founder',
    members:[{trainer_name:'Trainer B'}],
  }
  assert.equal(onlineTrainingReportTrainerName(report),'Trainer A')
})

test('one normalized member trainer repairs a blank legacy report trainer',()=>{
  const report={
    trainer_name:'',author_name:'Founder',
    members:[{trainer_name:'Trainer-A'},{trainer_name:' trainer a '}],
  }
  assert.equal(onlineTrainingReportTrainerName(report),'Trainer-A')
  assert.equal(onlineTrainingReportMatchesTrainer(report,'TRAINER A'),true)
})

test('mixed member trainers fail closed to the audit author',()=>{
  const report={
    trainer_name:'',author_name:'Founder',
    members:[{trainer_name:'Trainer A'},{trainer_name:'Trainer B'}],
  }
  assert.equal(onlineTrainingReportTrainerName(report),'Founder')
  assert.equal(onlineTrainingReportMatchesTrainer(report,'Trainer A'),false)
})

test('author employee number is the final legacy fallback',()=>{
  const report={trainer_name:'',author_name:'',author_employee_no:'ADMIN-01',members:[]}
  assert.equal(onlineTrainingReportTrainerName(report),'ADMIN-01')
  assert.equal(onlineTrainingIdentityKey(' Admin-01 '),'admin01')
})
