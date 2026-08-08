"""Small encoder-decoder transformer: continuous note features -> tempo-DSL tokens."""

import math

import torch
import torch.nn as nn

from dsl import VOCAB
from dataset import N_FEATURES


class PositionalEncoding(nn.Module):
    def __init__(self, d_model, max_len=2048):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(max_len).unsqueeze(1).float()
        div = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)
        self.register_buffer("pe", pe)

    def forward(self, x):
        return x + self.pe[: x.shape[1]].unsqueeze(0)


class TempoTransformer(nn.Module):
    def __init__(self, d_model=256, nhead=8, enc_layers=4, dec_layers=4, ff=1024,
                 dropout=0.1, n_features=N_FEATURES, vocab_size=None):
        super().__init__()
        vocab_size = vocab_size or len(VOCAB)
        self.in_proj = nn.Sequential(
            nn.Linear(n_features, d_model), nn.GELU(), nn.Linear(d_model, d_model)
        )
        self.pos_enc = PositionalEncoding(d_model)
        self.tok_emb = nn.Embedding(vocab_size, d_model)
        self.pos_dec = PositionalEncoding(d_model)
        self.transformer = nn.Transformer(
            d_model=d_model, nhead=nhead,
            num_encoder_layers=enc_layers, num_decoder_layers=dec_layers,
            dim_feedforward=ff, dropout=dropout, batch_first=True, norm_first=True,
        )
        self.head = nn.Linear(d_model, vocab_size)

    def forward(self, x, x_pad_mask, y_in):
        src = self.pos_enc(self.in_proj(x))
        tgt = self.pos_dec(self.tok_emb(y_in))
        T = y_in.shape[1]
        causal = nn.Transformer.generate_square_subsequent_mask(T, device=y_in.device)
        out = self.transformer(
            src, tgt,
            tgt_mask=causal,
            src_key_padding_mask=x_pad_mask,
            memory_key_padding_mask=x_pad_mask,
        )
        return self.head(out)

    @torch.no_grad()
    def greedy_decode(self, x, x_pad_mask, max_len=256, bos=1, eos=2):
        self.eval()
        B = x.shape[0]
        src = self.pos_enc(self.in_proj(x))
        memory = self.transformer.encoder(src, src_key_padding_mask=x_pad_mask)
        ys = torch.full((B, 1), bos, dtype=torch.long, device=x.device)
        done = torch.zeros(B, dtype=torch.bool, device=x.device)
        for _ in range(max_len - 1):
            tgt = self.pos_dec(self.tok_emb(ys))
            T = ys.shape[1]
            causal = nn.Transformer.generate_square_subsequent_mask(T, device=x.device)
            out = self.transformer.decoder(
                tgt, memory, tgt_mask=causal, memory_key_padding_mask=x_pad_mask
            )
            nxt = self.head(out[:, -1]).argmax(-1)
            nxt = torch.where(done, torch.full_like(nxt, 0), nxt)
            ys = torch.cat([ys, nxt.unsqueeze(1)], dim=1)
            done |= nxt == eos
            if bool(done.all()):
                break
        return ys
