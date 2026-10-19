import { Controller, Post, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RefundService } from './refund.service';

@Controller('orders')
export class RefundController {
  constructor(private readonly refunds: RefundService) {}

  @UseGuards(AuthGuard('jwt'))
  @Post(':id/refund')
  refund(@Param('id') id: string) {
    return this.refunds.refund(id);
  }
}
