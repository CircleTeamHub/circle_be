import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

/** 点赞操作后 / 资料页携带的点赞状态。 */
export class LikeStatusDto {
  @ApiProperty({ example: 12, description: '该用户收到的累计点赞总数' })
  @Expose()
  likeCount: number;

  @ApiProperty({
    example: false,
    description: '当前登录用户今天是否已为其点赞',
  })
  @Expose()
  likedByMeToday: boolean;
}
