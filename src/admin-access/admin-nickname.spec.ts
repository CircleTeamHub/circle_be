import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AdminAccessService } from './admin-access.service';
import { UpdateAdminNicknameDto } from './admin-access.dto';

describe('administrator nickname',()=>{
 it('accepts a trimmed display name and rejects blank or oversized values',()=>{
  const dto=plainToInstance(UpdateAdminNicknameDto,{nickname:' 管理员 '});expect(validateSync(dto)).toHaveLength(0);expect(dto.nickname).toBe('管理员');
  for(const nickname of ['', '   ', 'x'.repeat(51),null])expect(validateSync(plainToInstance(UpdateAdminNicknameDto,{nickname}))).not.toHaveLength(0);
 });
 it('updates only the authenticated administrator nickname and writes audit atomically',async()=>{
  const tx={user:{findFirst:jest.fn().mockResolvedValue({id:'self',nickname:'Old',accountId:'admin'}),updateMany:jest.fn().mockResolvedValue({count:1})},adminAuditLog:{create:jest.fn()}};
  const prisma={$transaction:jest.fn(async(fn:any)=>fn(tx))};const service=new AdminAccessService(prisma as any);
  expect(await service.updateNickname('self','New')).toEqual({id:'self',nickname:'New'});
  expect(tx.user.updateMany).toHaveBeenCalledWith({where:{id:'self',role:'ADMIN',status:'ACTIVE'},data:{nickname:'New'}});
  expect(tx.adminAuditLog.create).toHaveBeenCalledWith({data:expect.objectContaining({actorID:'self',entityID:'self',action:'admin.nickname.update',before:{nickname:'Old'},after:{nickname:'New'}})});
 });
 it('rejects an unavailable administrator before writing anything',async()=>{
  const tx={user:{findFirst:jest.fn().mockResolvedValue(null),updateMany:jest.fn()},adminAuditLog:{create:jest.fn()}};
  const service=new AdminAccessService({$transaction:async(fn:any)=>fn(tx)} as any);
  await expect(service.updateNickname('self','New')).rejects.toMatchObject({status:403});expect(tx.user.updateMany).not.toHaveBeenCalled();expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
 });
});
